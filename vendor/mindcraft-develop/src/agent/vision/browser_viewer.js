import settings from '../settings.js';

// [MCBOT vendor patch V-1a] 原文件第 2 行为模块顶层静态 import：
//     import prismarineViewer from 'prismarine-viewer';
//     const mineflayerViewer = prismarineViewer.mineflayer;
// 而 agent.js 第 14 行 import 了本文件 —— 于是每个 agent 进程都必然加载
// prismarine-viewer → canvas / node-canvas-webgl / gl 整条原生依赖链，
// 即便 render_bot_view=false（运行时那层 if 保护不了 import 阶段）。
// 后果：没有 MSVC 工具链或预编译包装不上时，agent.js 直接不可加载。
// 改为按需动态 import：不渲染就永远不碰这条链，原生依赖可以完全不安装。

export async function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view) return;
    try {
        const prismarineViewer = (await import('prismarine-viewer')).default;
        prismarineViewer.mineflayer(bot, { port: 3000 + count_id, firstPerson: true });
    } catch (err) {
        console.error('[MCBOT] render_bot_view is enabled but prismarine-viewer could not be loaded:', err.message);
    }
}
