const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid'); // 使用 uuid 库生成唯一ID

// To run this, you need to install ws and uuid: npm install ws uuid
const PORT = process.env.PORT || 8088;
const wss = new WebSocket.Server({ port: PORT });

const clients = new Map(); // 存储所有客户端信息 { id, role, username, ws }
let broadcasterId = null;

console.log(`✅ Signaling server started on ws://localhost:${PORT}`);

wss.on('connection', ws => {
    const clientId = uuidv4();
    console.log(`ℹ️ Client connected, assigned ID: ${clientId}`);
    clients.set(clientId, { id: clientId, role: null, username: null, ws: ws });

    ws.on('message', messageString => {
        let message;
        try {
            message = JSON.parse(messageString);
        } catch (e) {
            console.error('❌ Failed to parse message:', messageString);
            return;
        }

        console.log(`↪️ Received message type: ${message.type} from ${clientId}`);

        switch (message.type) {
            case 'register':
                handleRegistration(clientId, message.payload);
                break;
            
            case 'offer':
            case 'answer':
            case 'candidate':
                routeMessage(clientId, message);
                break;

            case 'kick-user':
                handleKickUser(clientId, message.payload);
                break;
            
            default:
                console.warn(`⚠️ Unhandled message type: ${message.type}`);
        }
    });

    ws.on('close', () => {
        console.log(`ℹ️ Client disconnected: ${clientId}`);
        const clientInfo = clients.get(clientId);
        if (clientInfo) {
            // If the broadcaster disconnects, notify all viewers
            if (clientInfo.role === 'broadcaster') {
                console.log('📣 Broadcaster has disconnected. Notifying viewers...');
                broadcasterId = null;
                clients.forEach(c => {
                    if (c.role === 'viewer') {
                        c.ws.send(JSON.stringify({ type: 'broadcaster-disconnected' }));
                    }
                });
            } else if (clientInfo.role === 'viewer' && broadcasterId) {
                // If a viewer disconnects, notify the broadcaster
                const broadcasterClient = clients.get(broadcasterId);
                if (broadcasterClient) {
                    broadcasterClient.ws.send(JSON.stringify({ type: 'viewer-disconnected', payload: { viewerId: clientId } }));
                }
            }
        }
        clients.delete(clientId);
    });

    ws.on('error', (error) => {
        console.error(`❌ Server error for client ${clientId}:`, error);
    });
});

function handleKickUser(senderId, payload) {
    if (senderId !== broadcasterId) {
        console.warn(`⚠️ Non-broadcaster client ${senderId} attempted to kick a user. Action denied.`);
        return;
    }

    const { targetId } = payload;
    const targetClient = clients.get(targetId);

    if (targetClient) {
        console.log(`👢 Kicking user ${targetId} by broadcaster's request.`);
        // Optionally send a message to the user before kicking
        targetClient.ws.send(JSON.stringify({ type: 'kicked', payload: { reason: '您已被主播移出直播间' } }));
        // Close the connection
        targetClient.ws.close();
    } else {
        console.warn(`⚠️ Broadcaster tried to kick non-existent user ${targetId}.`);
    }
}

function handleRegistration(clientId, payload) {
    const { role, username } = payload;
    const clientInfo = clients.get(clientId);
    if (!clientInfo) return;

    clientInfo.role = role;
    clientInfo.username = username || `User-${clientId.substring(0, 4)}`;
    console.log(`✍️  Registered client ${clientId} as a ${role} with username ${clientInfo.username}`);

    if (role === 'broadcaster') {
        if (broadcasterId) {
            console.warn(`⚠️ A broadcaster is already registered. Overwriting with new broadcaster ${clientId}`);
        }
        broadcasterId = clientId;
    } else if (role === 'viewer') {
        if (broadcasterId) {
            const broadcasterClient = clients.get(broadcasterId);
            if (broadcasterClient) {
                console.log(`🔔 Notifying broadcaster (${broadcasterId}) of new viewer (${clientId})`);
                // Notify the broadcaster about the new viewer, including their username
                broadcasterClient.ws.send(JSON.stringify({ 
                    type: 'new-viewer', 
                    payload: { 
                        viewerId: clientId,
                        username: clientInfo.username 
                    } 
                }));
            }
        } else {
            console.log('ℹ️ A viewer connected, but no broadcaster is available yet.');
        }
    }
}

function routeMessage(senderId, message) {
    const targetId = message.payload.targetId;
    if (!targetId) {
        console.error('❌ Routing error: message is missing targetId', message);
        return;
    }
    
    const targetClient = clients.get(targetId);
    if (targetClient) {
        console.log(`✈️  Routing message from ${senderId} to ${targetId}`);
        // Add senderId to the payload so the recipient knows who sent it
        const outboundPayload = { ...message.payload, senderId };
        targetClient.ws.send(JSON.stringify({
            type: message.type,
            payload: outboundPayload
        }));
    } else {
        console.warn(`⚠️ Could not find target client with ID: ${targetId}`);
    }
}
