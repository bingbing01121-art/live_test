// 要运行此文件，需要先在终端中执行 `npm install ws` 来安装 WebSocket 库
const WebSocket = require('ws');

// 创建一个 WebSocket 服务器，监听 8080 端口
const PORT = process.env.PORT || 8088;
const wss = new WebSocket.Server({ port: PORT });
console.log(`✅ 信令服务器已启动在 ws://localhost:${PORT}`);

// 监听客户端连接事件
wss.on('connection', ws => {
    console.log('ℹ️ 一个客户端已连接');

    // 监听客户端发送的消息事件
    ws.on('message', message => {
        // 将接收到的消息（通常是 Buffer）转换为字符串以便处理和广播
        const messageString = message.toString();
        // console.log(`↪️  收到消息，内容（部分）：${messageString.substring(0, 100)}...`); // 打印部分消息内容，避免过长
        console.log('✈️  正在广播消息给其他客户端...');

        // 将消息广播给除发送者之外的所有其他连接的客户端
        wss.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(messageString);
            }
        });
    });

    // 监听客户端断开连接事件
    ws.on('close', () => {
        console.log('ℹ️ 一个客户端已断开');
    });

    // 监听错误事件
    ws.on('error', (error) => {
        console.error(`❌ 信令服务器发生错误: ${error}`);
    });
});
