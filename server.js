const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8088;
const wss = new WebSocket.Server({ port: PORT });

// --- Data Structures ---
const clients = new Map(); // Maps connection-specific clientId -> { id, ws, persistentId, username }
const persistentIdToClientId = new Map(); // Maps persistentId -> clientId
const rooms = new Map(); // Maps roomId -> { id, name, broadcasterId, viewers: Set<persistentId> }
const persistentIdToRoomId = new Map(); // Maps persistentId -> roomId

console.log(`✅ Signaling server for multi-room chat started on ws://localhost:${PORT}`);

// --- WebSocket Connection Handler ---
wss.on('connection', ws => {
    const clientId = uuidv4();
    clients.set(clientId, { id: clientId, ws: ws });
    console.log(`ℹ️  Client connected with temporary ID: ${clientId}`);

    ws.on('message', messageString => {
        let message;
        try {
            message = JSON.parse(messageString);
        } catch (e) {
            console.error('❌ Failed to parse message:', messageString);
            return;
        }

        const clientInfo = clients.get(clientId);
        if (!clientInfo) return;

        const logId = clientInfo.persistentId || clientId;
        console.log(`↪️  [${logId}] Received: ${message.type}`);

        switch (message.type) {
            // User & Room Management
            case 'register':
                handleRegistration(clientId, message.payload);
                break;
            case 'create-room':
                handleCreateRoom(clientInfo, message.payload);
                break;
            case 'list-rooms':
                handleListRooms(clientInfo);
                break;
            case 'join-room':
                handleJoinRoom(clientInfo, message.payload);
                break;
            case 'leave-room':
                handleLeaveRoom(clientInfo);
                break;

            // WebRTC Signaling & In-Room Communication
            case 'offer':
            case 'answer':
            case 'candidate':
                routeP2PMessage(clientInfo.persistentId, message);
                break;
            case 'kick-user':
                handleKickUser(clientInfo, message.payload);
                break;
            
            default:
                console.warn(`⚠️  [${logId}] Unhandled message type: ${message.type}`);
        }
    });

    ws.on('close', () => handleDisconnect(clientId));
    ws.on('error', (error) => console.error(`❌ Error for client ${clientId}:`, error));
});

// --- Message Handlers ---

function handleRegistration(clientId, payload) {
    const { persistentId, username } = payload;
    if (!persistentId || !username) return console.error(`❌ Invalid registration from ${clientId}`);
    
    const clientInfo = clients.get(clientId);
    clientInfo.persistentId = persistentId;
    clientInfo.username = username;
    
    persistentIdToClientId.set(persistentId, clientId);
    console.log(`✍️   Registered ${clientId} as persistent user ${persistentId} (${username})`);

    // Acknowledge registration
    clientInfo.ws.send(JSON.stringify({ type: 'registered', payload: { userId: persistentId } }));
}

function handleCreateRoom(clientInfo, payload) {
    const { roomName } = payload;
    if (!roomName) return console.error('❌ Room creation failed: no room name provided.');
    
    const roomId = uuidv4();
    const broadcasterId = clientInfo.persistentId;

    const newRoom = {
        id: roomId,
        name: roomName,
        broadcasterId: broadcasterId,
        viewers: new Set()
    };
    rooms.set(roomId, newRoom);
    persistentIdToRoomId.set(broadcasterId, roomId);
    clientInfo.role = 'broadcaster';

    console.log(`🚪 Room created: "${roomName}" (ID: ${roomId}) by ${broadcasterId}`);
    clientInfo.ws.send(JSON.stringify({ type: 'room-created', payload: { roomId, roomName } }));
}

function handleListRooms(clientInfo) {
    const roomList = Array.from(rooms.values()).map(room => ({
        roomId: room.id,
        roomName: room.name,
        broadcasterName: clients.get(persistentIdToClientId.get(room.broadcasterId))?.username,
        viewerCount: room.viewers.size
    }));
    clientInfo.ws.send(JSON.stringify({ type: 'room-list', payload: roomList }));
}

function handleJoinRoom(clientInfo, payload) {
    const { roomId } = payload;
    const room = rooms.get(roomId);
    if (!room) {
        return clientInfo.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Room not found' } }));
    }

    const viewerId = clientInfo.persistentId;
    room.viewers.add(viewerId);
    persistentIdToRoomId.set(viewerId, roomId);
    clientInfo.role = 'viewer';

    console.log(`🔗 Viewer ${viewerId} joined room ${roomId}`);
    clientInfo.ws.send(JSON.stringify({ type: 'joined-room', payload: { roomId } }));

    // Notify broadcaster of the new viewer
    const broadcasterClient = clients.get(persistentIdToClientId.get(room.broadcasterId));
    if (broadcasterClient) {
        broadcasterClient.ws.send(JSON.stringify({
            type: 'new-viewer',
            payload: { viewerId, username: clientInfo.username }
        }));
    }
}

function handleLeaveRoom(clientInfo) {
    const viewerId = clientInfo.persistentId;
    const roomId = persistentIdToRoomId.get(viewerId);
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (room) {
        room.viewers.delete(viewerId);
        console.log(`👋 Viewer ${viewerId} left room ${roomId}`);

        // Notify broadcaster
        const broadcasterClient = clients.get(persistentIdToClientId.get(room.broadcasterId));
        if (broadcasterClient) {
            broadcasterClient.ws.send(JSON.stringify({ type: 'viewer-left', payload: { viewerId } }));
        }
    }
    persistentIdToRoomId.delete(viewerId);
    clientInfo.role = null;
}

function handleDisconnect(clientId) {
    const clientInfo = clients.get(clientId);
    if (!clientInfo || !clientInfo.persistentId) {
        console.log(`ℹ️  Temporary client ${clientId} disconnected.`);
        return clients.delete(clientId);
    }

    const { persistentId, role } = clientInfo;
    const roomId = persistentIdToRoomId.get(persistentId);
    console.log(`ℹ️  User ${persistentId} disconnected.`);

    if (role === 'broadcaster' && roomId) {
        const room = rooms.get(roomId);
        console.log(`📣 Broadcaster of room ${roomId} disconnected. Closing room.`);
        room.viewers.forEach(viewerId => {
            const viewerClient = clients.get(persistentIdToClientId.get(viewerId));
            if (viewerClient) {
                viewerClient.ws.send(JSON.stringify({ type: 'room-closed', payload: { roomId } }));
                persistentIdToRoomId.delete(viewerId);
            }
        });
        rooms.delete(roomId);
    } else if (role === 'viewer' && roomId) {
        handleLeaveRoom(clientInfo);
    }

    clients.delete(clientId);
    persistentIdToClientId.delete(persistentId);
}

function routeP2PMessage(senderId, message) {
    const targetId = message.payload.targetId;
    if (!targetId) return console.error('❌ P2P routing error: message is missing targetId');
    
    const targetClientId = persistentIdToClientId.get(targetId);
    const targetClient = clients.get(targetClientId);

    if (targetClient) {
        // Add sender's persistentId to the payload for context
        const outboundPayload = { ...message.payload, senderId };
        targetClient.ws.send(JSON.stringify({ type: message.type, payload: outboundPayload }));
    } else {
        console.warn(`⚠️  Could not find target client with persistent ID: ${targetId}`);
    }
}

function handleKickUser(broadcasterInfo, payload) {
    const { targetId } = payload; // viewer's persistentId
    const roomId = persistentIdToRoomId.get(broadcasterInfo.persistentId);
    const room = rooms.get(roomId);

    if (!room || room.broadcasterId !== broadcasterInfo.persistentId) {
        return console.warn(`⚠️  Kick attempt by non-broadcaster or invalid room.`);
    }

    if (!room.viewers.has(targetId)) {
        return console.warn(`⚠️  Kick attempt on user ${targetId} not in room ${roomId}.`);
    }

    const targetClientId = persistentIdToClientId.get(targetId);
    const targetClient = clients.get(targetClientId);

    if (targetClient) {
        console.log(`👢 Kicking user ${targetId} from room ${roomId}.`);
        targetClient.ws.send(JSON.stringify({ type: 'kicked', payload: { reason: '您已被主播移出直播间' } }));
        
        // Use a timeout to ensure the message is sent before the connection is closed
        setTimeout(() => {
            targetClient.ws.close();
        }, 100);
        
        // No need to call handleLeaveRoom, as the 'close' event will trigger cleanup
    }
}