/**
 * live_test/server.js
 * 
 * 这是一个基于 WebSocket 的信令服务器，用于支持 WebRTC 实时音视频通信。
 * 它管理客户端连接、房间创建与加入、WebRTC 信令交换，以及主播重连和房间密码保护等功能。
 */
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const config = require('./config'); // 导入配置文件

// 设置服务器端口，优先使用环境变量PORT，否则使用8088
const PORT = process.env.PORT || 8088;
// 创建WebSocket服务器
const wss = new WebSocket.Server({ port: PORT });

// 定义主播异常断开后允许重连的宽限时间（毫秒），在此期间房间不会被立即关闭
const RECONNECT_TIMEOUT_MS = 30000; // 30 seconds for broadcaster reconnect grace period

// --- 数据结构 ---
// 存储所有连接的客户端信息，键为客户端的临时ID (clientId)，值为包含客户端ID、WebSocket连接、持久化ID和用户名的对象
const clients = new Map(); // Maps connection-specific clientId -> { id, ws, persistentId, username }
// 存储持久化ID到临时客户端ID的映射，方便通过持久化ID查找客户端
const persistentIdToClientId = new Map(); // Maps persistentId -> clientId
// 存储所有房间的信息，键为房间ID (roomId)，值为包含房间ID、名称、主播ID、观众列表、被禁言观众列表、主播静音状态、房间状态和重连超时ID的对象
const rooms = new Map(); // Maps roomId -> { id, name, broadcasterId, viewers: Set<persistentId>, mutedViewers: Set<persistentId>, isAnchorMuted, status, reconnectTimeout }
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
            case 'rejoin-room': // New case for handling broadcaster rejoin
                handleRejoinRoom(clientInfo, message.payload);
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
            // (request-ice-servers case removed as ICE servers are now sent with 'registered')
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
            case 'update-room-password':
                handleUpdateRoomPassword(clientInfo, message.payload);
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
    clientInfo.ws.send(JSON.stringify({ 
        type: 'registered', 
        payload: { 
            userId: persistentId,
            iceServers: config.iceServers // <-- 添加ICE服务器列表
        } 
    }));
}

/**
 * 处理创建房间消息
 * @param {object} clientInfo - 客户端信息
 * @param {object} payload - 消息负载，包含房间名称
 */
function handleCreateRoom(clientInfo, payload) {
    const { roomName, password } = payload; // Added password
    console.log(`[handleCreateRoom] Received password: "${password}" for room: "${roomName}"`); // New log: received password
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
        isAnchorMuted: false, // 主播自身是否静音的状态
        status: 'active', // 房间状态：'active' / 'inactive' / 'pending_rejoin'
        reconnectTimeout: null, // 重连超时ID，用于存储 setTimeout 的ID，以便清除
        password: password || null // 存储房间密码，如果客户端未提供则为 null。支持密码保护的房间。
    };
    console.log(`[handleCreateRoom] Stored room password: "${newRoom.password}" for room: "${roomName}" (ID: ${roomId})`); // New log: stored password
    rooms.set(roomId, newRoom); // 将新房间添加到房间列表中
    persistentIdToRoomId.set(broadcasterId, roomId); // 记录主播所在的房间
    clientInfo.role = 'broadcaster'; // 设置客户端角色为主播

    console.log(`🚪 房间已创建: "${roomName}" (ID: ${roomId}) 由 ${broadcasterId} 创建`);
    // 向主播发送房间创建成功的消息
            clientInfo.ws.send(JSON.stringify({ type: 'room-created', payload: { roomId, roomName } }));
    }
    
    /**
     * 处理重新加入房间消息 (主播重连后)
     * @param {object} clientInfo - 客户端信息
     * @param {object} payload - 消息负载，包含房间ID和房间名称
     */
    function handleRejoinRoom(clientInfo, payload) {
        const { roomId, roomName, password } = payload;
        const persistentId = clientInfo.persistentId;
    
        if (!persistentId) {
            return console.error(`❌ 重连房间失败: 客户端 ${clientInfo.id} 未注册持久化ID。`);
        }
    
        const room = rooms.get(roomId);
    
        if (!room || room.broadcasterId !== persistentId) {
            // 如果房间不存在，或主播ID不匹配，可能房间已关闭或错误
            console.warn(`⚠️  主播 ${persistentId} 尝试重连房间 ${roomId} 失败: 房间不存在或主播ID不匹配。`);
            // 通知主播重连失败，可能需要创建新房间
            return clientInfo.ws.send(JSON.stringify({ type: 'rejoin-room-failed', payload: { message: '房间不存在或主播身份不匹配' } }));
        }
    
        // 更新主播的当前WebSocket连接，确保其关联到房间
        persistentIdToClientId.set(persistentId, clientInfo.id);
        clientInfo.role = 'broadcaster'; // 确保角色是主播
    
        // 可以在这里更新房间名称，如果主播在重连时修改了名称（虽然通常不会）
        if (room.name !== roomName) {
            room.name = roomName;
            console.log(`ℹ️  房间 ${roomId} 的名称已更新为 "${roomName}"。`);
        }
        // Update password if provided, or clear if empty
        room.password = password || null; // 主播重连时，更新或清除房间密码
        console.log(`ℹ️  房间 ${roomId} 的密码已更新。`);
        
        // 如果主播在宽限期内重连成功，则清除房间的自动关闭计时器，并重新激活房间
        if (room.reconnectTimeout) {
            clearTimeout(room.reconnectTimeout);
            room.reconnectTimeout = null;
        }
        room.status = 'active'; // 主播重连成功，房间状态重新激活为 'active'
    
        console.log(`✅ 主播 ${persistentId} 成功重连房间 "${room.name}" (ID: ${roomId})。`);        // 向主播发送重连成功的消息
        clientInfo.ws.send(JSON.stringify({ type: 'room-rejoined', payload: { roomId: room.id, roomName: room.name } }));
    
        // 通知所有观众主播已重新连接（如果他们在线且还在该房间）
        room.viewers.forEach(viewerPersistentId => {
            const viewerClient = clients.get(persistentIdToClientId.get(viewerPersistentId));
            if (viewerClient && viewerPersistentId !== persistentId) { // 避免发给自己
                viewerClient.ws.send(JSON.stringify({ type: 'broadcaster-rejoined', payload: { roomId: room.id, broadcasterId: persistentId } }));
            }
        });

        // 关键新增：重连后立即广播最新的观众列表，促使主播为现有观众重建 P2P 连接
        sendViewerListUpdate(room);
    }

/**
 * 处理列出房间消息
 * @param {object} clientInfo - 请求列表的客户端信息
 */
function handleListRooms(clientInfo) {
    console.log(`ℹ️  客户端 ${clientInfo.persistentId || clientInfo.id} 请求房间列表。`);
    
    // 过滤出所有活跃或正在等待重连的房间
    const visibleRooms = Array.from(rooms.values()).filter(room => 
        room.status === 'active' || room.status === 'pending_rejoin'
    );

    // 构建一个简化的房间信息列表以供发送
    const roomListForClient = visibleRooms.map(room => {
        // 获取主播的用户名
        const broadcasterClient = clients.get(persistentIdToClientId.get(room.broadcasterId));
        const broadcasterName = broadcasterClient ? broadcasterClient.username : '主播已离线(待重连)';

        return {
            id: room.id,
            name: room.name,
            broadcasterName: broadcasterName,
            viewerCount: room.viewers.size,
            isPasswordProtected: !!room.password,
            isReconnecting: room.status === 'pending_rejoin' // 新增：标识主播是否掉线重连中
        };
    });

    // 将房间列表发送给请求的客户端
    clientInfo.ws.send(JSON.stringify({
        type: 'room-list',
        payload: {
            rooms: roomListForClient
        }
    }));
    
    console.log(`📤  已向 ${clientInfo.persistentId || clientInfo.id} 发送 ${roomListForClient.length} 个活跃房间的信息。`);
}

/**
 * 处理加入房间消息
 * @param {object} clientInfo - 客户端信息
 * @param {object} payload - 消息负载，包含房间ID和可选的密码
 */
function handleJoinRoom(clientInfo, payload) {
    const { roomId, password } = payload;
    const room = rooms.get(roomId);

    // 检查房间是否存在
    if (!room) {
        console.warn(`⚠️  观众 ${clientInfo.persistentId} 尝试加入房间 ${roomId}，但房间未找到。`);
        return clientInfo.ws.send(JSON.stringify({ type: 'error', payload: { message: '房间未找到', code: 'ROOM_NOT_FOUND' } }));
    }

    // 检查房间是否受密码保护，并验证提供的密码
    if (room.password && room.password !== password) {
        console.warn(`⚠️  观众 ${clientInfo.persistentId} 尝试加入密码保护房间 ${roomId}，但密码错误。`);
        return clientInfo.ws.send(JSON.stringify({ type: 'error', payload: { message: '密码错误', code: 'PASSWORD_INCORRECT' } }));
    }

    const viewerId = clientInfo.persistentId;
    room.viewers.add(viewerId);
    persistentIdToRoomId.set(viewerId, roomId);
    clientInfo.role = 'viewer';

    console.log(`🔗 观众 ${viewerId} 加入房间 ${roomId}`);
    
    // 向观众发送加入房间成功的消息
    clientInfo.ws.send(JSON.stringify({ 
        type: 'joined-room', 
        payload: { 
            roomId: room.id,
            broadcasterId: room.broadcasterId // 将主播ID也发给观众
        } 
    }));

    // 通知主播有新观众加入
    const broadcasterClient = clients.get(persistentIdToClientId.get(room.broadcasterId));
    if (broadcasterClient) {
        broadcasterClient.ws.send(JSON.stringify({
            type: 'new-viewer',
            payload: {
                viewerId,
                username: clientInfo.username,
                isMuted: room.mutedViewers.has(viewerId)
            }
        }));
    }

    // 如果观众之前被禁言，加入时通知其状态
    if (room.mutedViewers.has(viewerId)) {
        clientInfo.ws.send(JSON.stringify({
            type: 'viewer-muted-status',
            payload: { viewerId, isMuted: true }
        }));
    }

    // 通知新加入的观众关于主播当前的静音状态
    if (room.isAnchorMuted) {
        clientInfo.ws.send(JSON.stringify({
            type: 'live.anchor.mute',
            payload: { anchorId: room.broadcasterId, isMuted: true }
        }));
    }

    console.log(`ℹ️  在 handleJoinRoom 中调用 sendViewerListUpdate (房间 ${room.id})`); // New log for debugging
    // 广播更新后的观众列表给所有客户端 (包括新加入的观众和主播)
    sendViewerListUpdate(room);
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
        if (!room) { // 理论上不会发生，因为 roomId 应该有效
            console.warn(`⚠️  主播 ${persistentId} 断开连接，但房间 ${roomId} 不存在。`);
            return;
        }

        // 将房间状态设为“待重连”，并通知观众主播暂时断开
        room.status = 'pending_rejoin';
        console.log(`📣 房间 ${roomId} 的主播 ${persistentId} 断开连接。房间进入待重连状态。`);

        // 通知所有观众主播暂时断开连接 (而不是房间关闭)，以便客户端可以显示“主播已离开”或尝试重新协商
        room.viewers.forEach(viewerId => {
            const viewerClient = clients.get(persistentIdToClientId.get(viewerId));
            if (viewerClient) {
                viewerClient.ws.send(JSON.stringify({ type: 'broadcaster-disconnected', payload: { roomId } }));
            }
        });

        // 设置一个超时计时器，如果在宽限期内主播未能重连，则自动关闭房间
        room.reconnectTimeout = setTimeout(() => {
            console.log(`❌ 房间 ${roomId} 的主播重连超时，正在关闭房间。`);
            // 通知所有观众房间已关闭，并执行清理
            room.viewers.forEach(viewerId => {
                const viewerClient = clients.get(persistentIdToClientId.get(viewerId));
                if (viewerClient) {
                    viewerClient.ws.send(JSON.stringify({ type: 'room-closed', payload: { roomId } }));
                    persistentIdToRoomId.delete(viewerId); // 清除观众的房间信息
                }
            });
            rooms.delete(roomId); // 从房间列表中删除房间
            console.log(`🗑️  房间 ${roomId} 已被删除。`);
        }, RECONNECT_TIMEOUT_MS);
    } 
    // 如果是观众断开连接，则从房间中移除观众
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
        console.log(`ℹ️  在 handleDisconnect 中调用 sendViewerListUpdate (房间 ${room.id})`); // New log for debugging
        // 广播更新后的观众列表
        sendViewerListUpdate(room);
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
 * 处理更新房间密码消息
 * @param {object} clientInfo - 主播的客户端信息
 * @param {object} payload - 消息负载，包含 roomId 和 password
 */
function handleUpdateRoomPassword(clientInfo, payload) {
    const { roomId, password } = payload;
    const persistentId = clientInfo.persistentId;
    const room = rooms.get(roomId);

    // 检查房间是否存在且操作者是主播
    if (!room || room.broadcasterId !== persistentId) {
        console.warn(`⚠️  用户 ${persistentId} 尝试更新房间 ${roomId} 的密码，但不是主播或房间无效。`);
        // 可选：向客户端发送错误消息
        return clientInfo.ws.send(JSON.stringify({ type: 'error', payload: { message: '无权操作或房间无效', code: 'UNAUTHORIZED_OR_ROOM_INVALID' } }));
    }

    room.password = password && password.length > 0 ? password : null; // 更新房间密码，空字符串表示清除密码
    console.log(`🔑 房间 ${roomId} 的密码已由主播 ${persistentId} 更新为: ${room.password ? '[已设置]' : '[无密码]'}`);

    // 可选：向主播发送确认消息
    clientInfo.ws.send(JSON.stringify({ type: 'room-password-updated', payload: { roomId, hasPassword: !!room.password } }));
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
 * 将房间内所有观众（包括主播，如果在线）的列表广播给所有观众。
 * @param {object} room - 房间对象
 */
function sendViewerListUpdate(room) {
    if (!room) return;

    const viewersInRoom = [];
    // 添加主播到观众列表（如果主播在线）
    const broadcasterClient = clients.get(persistentIdToClientId.get(room.broadcasterId));
    if (broadcasterClient && broadcasterClient.ws.readyState === WebSocket.OPEN) {
        viewersInRoom.push({ id: broadcasterClient.persistentId, username: broadcasterClient.username, role: 'broadcaster' });
    }

    // 添加所有观众到列表
    room.viewers.forEach(viewerPersistentId => {
        const viewerClient = clients.get(persistentIdToClientId.get(viewerPersistentId));
        if (viewerClient && viewerClient.ws.readyState === WebSocket.OPEN) {
            viewersInRoom.push({ id: viewerClient.persistentId, username: viewerClient.username, role: 'viewer' });
        }
    });

    console.log(`ℹ️  房间 ${room.id} 准备发送观众列表更新: ${JSON.stringify(viewersInRoom)}`); // New log for debugging

    const updateMessage = JSON.stringify({
        type: 'viewer-list-update',
        payload: {
            viewers: viewersInRoom
        }
    });

    // 广播给房间内的所有客户端 (包括主播和观众)
    // 遍历所有在房间内的客户端，发送更新
    if (broadcasterClient && broadcasterClient.ws.readyState === WebSocket.OPEN) {
        broadcasterClient.ws.send(updateMessage);
    }
    room.viewers.forEach(viewerPersistentId => {
        const viewerClient = clients.get(persistentIdToClientId.get(viewerPersistentId));
        if (viewerClient && viewerClient.ws.readyState === WebSocket.OPEN) {
            viewerClient.ws.send(updateMessage);
        }
    });

    console.log(`📡 房间 ${room.id} 的观众列表已更新并广播给 ${viewersInRoom.length} 个客户端。`);
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
        console.log(`ℹ️  在 handleKickUser 中调用 sendViewerListUpdate (房间 ${room.id})`); // New log for debugging
        // 广播更新后的观众列表
        sendViewerListUpdate(room);
        // 无需调用 handleLeaveRoom，因为 'close' 事件会触发清理
    }

}