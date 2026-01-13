const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const config = require('./config'); // 导入配置文件

// 设置服务器端口，优先使用环境变量PORT，否则使用8088
const PORT = process.env.PORT || 8088;
// 创建WebSocket服务器
const wss = new WebSocket.Server({ port: PORT });

// --- 数据结构 ---
// 存储所有连接的客户端信息，键为客户端的临时ID (clientId)，值为包含客户端ID、WebSocket连接、持久化ID和用户名的对象
const clients = new Map(); // Maps connection-specific clientId -> { id, ws, persistentId, username }
// 存储持久化ID到临时客户端ID的映射，方便通过持久化ID查找客户端
const persistentIdToClientId = new Map(); // Maps persistentId -> clientId
// 存储所有房间的信息，键为房间ID (roomId)，值为包含房间ID、名称、主播ID、观众列表和被禁言观众列表的对象
const rooms = new Map(); // Maps roomId -> { id, name, broadcasterId, viewers: Set<persistentId>, mutedViewers: Set<persistentId> }
// 存储持久化ID到房间ID的映射，方便查找用户所在的房间
const persistentIdToRoomId = new Map(); // Maps persistentId -> roomId

console.log(`✅ 多房间聊天信令服务器已启动在 ws://localhost:${PORT}`);

// --- WebSocket 连接处理 ---
// 当有新的WebSocket连接建立时触发
wss.on('connection', ws => {
    // 为每个新连接生成一个临时的客户端ID
    const clientId = uuidv4();
    // 存储客户端信息
    clients.set(clientId, { id: clientId, ws: ws });
    console.log(`ℹ️  客户端已连接，临时ID为: ${clientId}`);

    // 处理接收到的消息
    ws.on('message', messageString => {
        let message;
        try {
            // 解析JSON格式的消息
            message = JSON.parse(messageString);
        } catch (e) {
            console.error('❌ 解析消息失败:', messageString);
            return;
        }

        // 获取客户端信息
        const clientInfo = clients.get(clientId);
        if (!clientInfo) return;

        // 用于日志记录的ID，如果已注册则使用持久化ID，否则使用临时ID
        const logId = clientInfo.persistentId || clientId;
        console.log(`↪️  [${logId}] 收到消息类型: ${message.type}`);

        // 根据消息类型分发处理
        switch (message.type) {
            // 用户与房间管理
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

            // 静音/取消静音功能
            case 'mute-viewer':
                handleMuteViewer(clientInfo, message.payload);
                break;
            case 'unmute-viewer':
                handleUnmuteViewer(clientInfo, message.payload);
                break;
            
            // 请求ICE服务器配置
            case 'request-ice-servers':
                handleRequestIceServers(clientInfo);
                break;

            // WebRTC 信令及房间内通信
            case 'offer':
            case 'answer':
            case 'candidate':
                routeP2PMessage(clientInfo.persistentId, message);
                break;
            case 'kick-user':
                handleKickUser(clientInfo, message.payload);
                break;
            case 'live.anchor.mute':
            case 'live.anchor.unmute':
                handleAnchorMuteStatus(clientInfo, message);
                break;
            
            default:
                console.warn(`⚠️  [${logId}] 未处理的消息类型: ${message.type}`);
        }
    });

    // 处理连接关闭事件
    ws.on('close', () => handleDisconnect(clientId));
    // 处理连接错误事件
    ws.on('error', (error) => console.error(`❌ 客户端 ${clientId} 发生错误:`, error));
});

// --- 消息处理器 ---

/**
 * 处理用户注册消息
 * @param {string} clientId - 客户端的临时ID
 * @param {object} payload - 消息负载，包含持久化ID和用户名
 */
function handleRegistration(clientId, payload) {
    const { persistentId, username } = payload;
    if (!persistentId || !username) return console.error(`❌ 来自 ${clientId} 的注册信息无效`);
    
    const clientInfo = clients.get(clientId);
    clientInfo.persistentId = persistentId;
    clientInfo.username = username;
    
    persistentIdToClientId.set(persistentId, clientId);
    console.log(`✍️   已将 ${clientId} 注册为持久化用户 ${persistentId} (${username})`);

    // 向客户端发送注册成功的确认消息
    clientInfo.ws.send(JSON.stringify({ type: 'registered', payload: { userId: persistentId } }));
}

/**
 * 处理创建房间消息
 * @param {object} clientInfo - 客户端信息
 * @param {object} payload - 消息负载，包含房间名称
 */
function handleCreateRoom(clientInfo, payload) {
    const { roomName } = payload;
    if (!roomName) return console.error('❌ 创建房间失败: 未提供房间名称。');
    
    const roomId = uuidv4(); // 生成唯一的房间ID
    const broadcasterId = clientInfo.persistentId; // 主播的持久化ID

    // 创建新的房间对象
    const newRoom = {
        id: roomId,
        name: roomName,
        broadcasterId: broadcasterId,
        viewers: new Set(), // 存储观众的持久化ID
        mutedViewers: new Set(), // 存储被禁言观众的持久化ID
        isAnchorMuted: false // 主播自身是否静音的状态
    };
    rooms.set(roomId, newRoom); // 将新房间添加到房间列表中
    persistentIdToRoomId.set(broadcasterId, roomId); // 记录主播所在的房间
    clientInfo.role = 'broadcaster'; // 设置客户端角色为主播

    console.log(`🚪 房间已创建: "${roomName}" (ID: ${roomId}) 由 ${broadcasterId} 创建`);
    // 向主播发送房间创建成功的消息
    clientInfo.ws.send(JSON.stringify({ type: 'room-created', payload: { roomId, roomName } }));
}

/**
 * 处理列出房间消息
 * @param {object} clientInfo - 客户端信息
 */
function handleListRooms(clientInfo) {
    // 遍历所有房间，构建房间列表信息
    const roomList = Array.from(rooms.values()).map(room => ({
        roomId: room.id,
        roomName: room.name,
        // 获取主播的用户名
        broadcasterName: clients.get(persistentIdToClientId.get(room.broadcasterId))?.username,
        viewerCount: room.viewers.size // 房间内的观众数量
    }));
    // 向客户端发送房间列表
    clientInfo.ws.send(JSON.stringify({ type: 'room-list', payload: roomList }));
}

/**
 * 处理加入房间消息
 * @param {object} clientInfo - 客户端信息
 * @param {object} payload - 消息负载，包含房间ID
 */
function handleJoinRoom(clientInfo, payload) {
    const { roomId } = payload;
    const room = rooms.get(roomId);
    if (!room) {
        // 如果房间不存在，发送错误消息
        return clientInfo.ws.send(JSON.stringify({ type: 'error', payload: { message: '房间未找到' } }));
    }

    const viewerId = clientInfo.persistentId; // 观众的持久化ID
    room.viewers.add(viewerId); // 将观众添加到房间的观众列表
    persistentIdToRoomId.set(viewerId, roomId); // 记录观众所在的房间
    clientInfo.role = 'viewer'; // 设置客户端角色为观众

    console.log(`🔗 观众 ${viewerId} 加入房间 ${roomId}`);
    // 向观众发送加入房间成功的消息
    clientInfo.ws.send(JSON.stringify({ type: 'joined-room', payload: { roomId } }));

    // 通知主播有新观众加入
    const broadcasterClient = clients.get(persistentIdToClientId.get(room.broadcasterId));
    if (broadcasterClient) {
        broadcasterClient.ws.send(JSON.stringify({
            type: 'new-viewer',
            payload: { 
                viewerId, 
                username: clientInfo.username,
                isMuted: room.mutedViewers.has(viewerId) // 发送初始的禁言状态
            }
        }));
    }

    // 如果观众已被禁言，通知观众自己的禁言状态
    if (room.mutedViewers.has(viewerId)) {
        clientInfo.ws.send(JSON.stringify({
            type: 'viewer-muted-status',
            payload: { viewerId, isMuted: true }
        }));
    }

    // 通知加入的观众主播当前的静音状态
    if (room.isAnchorMuted) {
        clientInfo.ws.send(JSON.stringify({
            type: 'live.anchor.mute',
            payload: { anchorId: room.broadcasterId, isMuted: true }
        }));
    }
}

/**
 * 处理离开房间消息
 * @param {object} clientInfo - 客户端信息
 */
function handleLeaveRoom(clientInfo) {
    const viewerId = clientInfo.persistentId; // 离开房间的观众ID
    const roomId = persistentIdToRoomId.get(viewerId); // 观众所在的房间ID
    if (!roomId) return; // 如果观众不在任何房间，则直接返回

    const room = rooms.get(roomId);
    if (room) {
        room.viewers.delete(viewerId); // 从房间观众列表中移除
        // 注意：此处不从 mutedViewers 中移除，因为用户可能重新加入
        console.log(`👋 观众 ${viewerId} 离开了房间 ${roomId}`);

        // 通知主播有观众离开
        const broadcasterClient = clients.get(persistentIdToClientId.get(room.broadcasterId));
        if (broadcasterClient) {
            broadcasterClient.ws.send(JSON.stringify({ type: 'viewer-left', payload: { viewerId } }));
        }
    }
    persistentIdToRoomId.delete(viewerId); // 从映射中移除观众的房间信息
    clientInfo.role = null; // 清除客户端的角色
}

/**
 * 处理客户端断开连接
 * @param {string} clientId - 断开连接的客户端临时ID
 */
function handleDisconnect(clientId) {
    const clientInfo = clients.get(clientId);
    // 如果客户端信息不存在或没有持久化ID，则认为是临时客户端断开
    if (!clientInfo || !clientInfo.persistentId) {
        console.log(`ℹ️  临时客户端 ${clientId} 断开连接。`);
        return clients.delete(clientId);
    }

    const { persistentId, role } = clientInfo;
    const roomId = persistentIdToRoomId.get(persistentId);
    console.log(`ℹ️  用户 ${persistentId} 断开连接。`);

    // 如果是主播断开连接
    if (role === 'broadcaster' && roomId) {
        const room = rooms.get(roomId);
        console.log(`📣 房间 ${roomId} 的主播断开连接。正在关闭房间。`);
        // 通知所有观众房间已关闭
        room.viewers.forEach(viewerId => {
            const viewerClient = clients.get(persistentIdToClientId.get(viewerId));
            if (viewerClient) {
                viewerClient.ws.send(JSON.stringify({ type: 'room-closed', payload: { roomId } }));
                persistentIdToRoomId.delete(viewerId); // 清除观众的房间信息
            }
        });
        rooms.delete(roomId); // 从房间列表中删除房间
        // 房间删除后，被禁言的观众状态自然也清除了
    } 
    // 如果是观众断开连接
    else if (role === 'viewer' && roomId) {
        const room = rooms.get(roomId);
        if (room) {
            room.viewers.delete(persistentId); // 从房间观众列表中移除
            room.mutedViewers.delete(persistentId); // 如果观众被禁言，也从禁言列表中移除
            console.log(`👋 观众 ${persistentId} 离开了房间 ${roomId} (断开连接)。`);

            // 通知主播有观众离开
            const broadcasterClient = clients.get(persistentIdToClientId.get(room.broadcasterId));
            if (broadcasterClient) {
                broadcasterClient.ws.send(JSON.stringify({ type: 'viewer-left', payload: { viewerId: persistentId } }));
            }
        }
        persistentIdToRoomId.delete(persistentId); // 从映射中移除观众的房间信息
    }

    clients.delete(clientId); // 从客户端列表中移除
    persistentIdToClientId.delete(persistentId); // 从持久化ID映射中移除
}

/**
 * 处理禁言观众消息
 * @param {object} broadcasterInfo - 主播的客户端信息
 * @param {object} payload - 消息负载，包含目标观众的持久化ID
 */
function handleMuteViewer(broadcasterInfo, payload) {
    const { targetId } = payload; // 目标观众的持久化ID
    const roomId = persistentIdToRoomId.get(broadcasterInfo.persistentId); // 主播所在的房间ID
    const room = rooms.get(roomId);

    // 检查房间是否存在且操作者是主播
    if (!room || room.broadcasterId !== broadcasterInfo.persistentId) {
        return console.warn(`⚠️  非主播尝试禁言或房间无效。`);
    }
    // 检查目标观众是否在房间内
    if (!room.viewers.has(targetId)) {
        return console.warn(`⚠️  尝试禁言不在房间 ${roomId} 的用户 ${targetId}。`);
    }

    room.mutedViewers.add(targetId); // 将观众添加到禁言列表
    console.log(`🤫 房间 ${roomId} 中的观众 ${targetId} 已被禁言。`);

    // 通知目标观众其被禁言的状态
    const targetViewerClient = clients.get(persistentIdToClientId.get(targetId));
    if (targetViewerClient) {
        targetViewerClient.ws.send(JSON.stringify({ type: 'viewer-muted-status', payload: { viewerId: targetId, isMuted: true } }));
    }
    // 通知主播更新UI（例如，按钮状态变化）
    broadcasterInfo.ws.send(JSON.stringify({ type: 'viewer-muted-status', payload: { viewerId: targetId, isMuted: true } }));
}

/**
 * 处理取消禁言观众消息
 * @param {object} broadcasterInfo - 主播的客户端信息
 * @param {object} payload - 消息负载，包含目标观众的持久化ID
 */
function handleUnmuteViewer(broadcasterInfo, payload) {
    const { targetId } = payload; // 目标观众的持久化ID
    const roomId = persistentIdToRoomId.get(broadcasterInfo.persistentId); // 主播所在的房间ID
    const room = rooms.get(roomId);

    // 检查房间是否存在且操作者是主播
    if (!room || room.broadcasterId !== broadcasterInfo.persistentId) {
        return console.warn(`⚠️  非主播尝试解除禁言或房间无效。`);
    }
    // 检查目标观众是否在房间内
    if (!room.viewers.has(targetId)) {
        return console.warn(`⚠️  尝试解除禁言不在房间 ${roomId} 的用户 ${targetId}。`);
    }

    room.mutedViewers.delete(targetId); // 从禁言列表中移除观众
    console.log(`🔊 房间 ${roomId} 中的观众 ${targetId} 已被解除禁言。`);

    // 通知目标观众其被解除禁言的状态
    const targetViewerClient = clients.get(persistentIdToClientId.get(targetId));
    if (targetViewerClient) {
        targetViewerClient.ws.send(JSON.stringify({ type: 'viewer-muted-status', payload: { viewerId: targetId, isMuted: false } }));
    }
    // 通知主播更新UI
    broadcasterInfo.ws.send(JSON.stringify({ type: 'viewer-muted-status', payload: { viewerId: targetId, isMuted: false } }));
}

/**
 * 处理请求ICE服务器配置的消息
 * @param {object} clientInfo - 客户端信息
 */
function handleRequestIceServers(clientInfo) {
    console.log(`🧊 客户端 ${clientInfo.persistentId || clientInfo.id} 请求ICE服务器配置。`);
    clientInfo.ws.send(JSON.stringify({ 
        type: 'ice-servers-response', 
        payload: { iceServers: config.iceServers } 
    }));
}

/**
 * 处理主播静音状态消息 (主播自己静音/取消静音)
 * @param {object} clientInfo - 主播的客户端信息
 * @param {object} message - 消息对象，包含类型和负载
 */
function handleAnchorMuteStatus(clientInfo, message) {
    const { type, payload } = message;
    const { anchorId, isMuted } = payload;

    const roomId = persistentIdToRoomId.get(anchorId); // 主播所在的房间ID
    const room = rooms.get(roomId);

    // 检查房间是否存在且操作者是主播
    if (!room || room.broadcasterId !== anchorId) {
        return console.warn(`⚠️  非主播尝试更新主播静音状态或房间无效。`);
    }

    room.isAnchorMuted = isMuted; // 更新房间内主播的静音状态
    console.log(`${isMuted ? '🔇' : '🔊'} 房间 ${roomId} 中的主播 ${anchorId} 已${isMuted ? '静音' : '取消静音'}。`);

    // 将主播的静音状态广播给房间内所有观众
    room.viewers.forEach(viewerId => {
        const viewerClient = clients.get(persistentIdToClientId.get(viewerId));
        if (viewerClient) {
            viewerClient.ws.send(JSON.stringify({ type: type, payload: { anchorId, isMuted } }));
        }
    });
}

/**
 * 路由P2P消息 (WebRTC 信令消息)
 * @param {string} senderId - 消息发送者的持久化ID
 * @param {object} message - 消息对象，包含类型和负载
 */
function routeP2PMessage(senderId, message) {
    const targetId = message.payload.targetId; // 目标接收者的持久化ID
    if (!targetId) return console.error('❌ P2P路由错误: 消息缺少targetId');
    
    const targetClientId = persistentIdToClientId.get(targetId); // 获取目标接收者的临时客户端ID
    const targetClient = clients.get(targetClientId); // 获取目标客户端信息

    if (targetClient) {
        // 将发送者的持久化ID添加到消息负载中，以便接收者知道消息来源
        const outboundPayload = { ...message.payload, senderId };
        targetClient.ws.send(JSON.stringify({ type: message.type, payload: outboundPayload }));
    } else {
        console.warn(`⚠️  找不到目标客户端，持久化ID为: ${targetId}`);
    }
}

/**
 * 处理踢出用户消息
 * @param {object} broadcasterInfo - 主播的客户端信息
 * @param {object} payload - 消息负载，包含目标观众的持久化ID
 */
function handleKickUser(broadcasterInfo, payload) {
    const { targetId } = payload; // 目标观众的持久化ID
    const roomId = persistentIdToRoomId.get(broadcasterInfo.persistentId); // 主播所在的房间ID
    const room = rooms.get(roomId);
    // 检查房间是否存在且操作者是主播
    if (!room || room.broadcasterId !== broadcasterInfo.persistentId) {
        return console.warn(`⚠️  非主播尝试踢出用户或房间无效。`);
    }

    // 检查目标观众是否在房间内
    if (!room.viewers.has(targetId)) {
        return console.warn(`⚠️  尝试踢出不在房间 ${roomId} 的用户 ${targetId}。`);
    }

    const targetClientId = persistentIdToClientId.get(targetId); // 获取目标观众的临时客户端ID
    const targetClient = clients.get(targetClientId); // 获取目标观众的客户端信息
    if (targetClient) {
        console.log(`👢 正在将用户 ${targetId} 从房间 ${roomId} 踢出。`);
        // 通知目标观众其被踢出房间
        targetClient.ws.send(JSON.stringify({ type: 'kicked', payload: { reason: '您已被主播移出直播间' } }));
        // 使用 setTimeout 确保消息在连接关闭前发送
        setTimeout(() => {
            targetClient.ws.close(); // 关闭目标观众的WebSocket连接
        }, 100);
        // 无需调用 handleLeaveRoom，因为 'close' 事件会触发清理
    }

}