import { Vec3 } from 'vec3';
import fs from 'fs';
// [MCBOT vendor patch V-1b] 原第 2 行为 `import { Camera } from "./camera.js";`（静态）。
// camera.js 顶层 import 了 prismarine-viewer、three、node-canvas-webgl 三个重量级/原生依赖；
// 而 agent.js 第 3 行静态 import 本文件 → 即使 allow_vision=false，加载 agent.js 也会
// 必然拉起整条原生链。改为在真正需要截图时才动态 import，见下方 getCamera()。

export class VisionInterpreter {
    constructor(agent, allow_vision) {
        this.agent = agent;
        this.allow_vision = allow_vision;
        this.fp = './bots/'+agent.name+'/screenshots/';
        // [MCBOT vendor patch V-1b] 不在构造时就 new Camera（那会立刻加载原生链），改为惰性创建。
        this.camera = null;
    }

    // [MCBOT vendor patch V-1b] 只有真的开启视觉并要截图时才加载 camera.js 及其原生依赖。
    async getCamera() {
        if (!this.camera) {
            const { Camera } = await import('./camera.js');
            this.camera = new Camera(this.agent.bot, this.fp);
        }
        return this.camera;
    }

    async lookAtPlayer(player_name, direction) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        let filename;
        if (direction === 'with') {
            await bot.look(player.yaw, player.pitch);
            result = `Looking in the same direction as ${player_name}\n`;
            filename = await (await this.getCamera()).capture();
        } else {
            await bot.lookAt(new Vec3(player.position.x, player.position.y + player.height, player.position.z));
            result = `Looking at player ${player_name}\n`;
            filename = await (await this.getCamera()).capture();

        }

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    async lookAtPosition(x, y, z) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        await bot.lookAt(new Vec3(x, y + 2, z));
        result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

        let filename = await (await this.getCamera()).capture();

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    getCenterBlockInfo() {
        const bot = this.agent.bot;
        const maxDistance = 128; // Maximum distance to check for blocks
        const targetBlock = bot.blockAtCursor(maxDistance);
        
        if (targetBlock) {
            return `Block at center view: ${targetBlock.name} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z})`;
        } else {
            return "No block in center view";
        }
    }

    async analyzeImage(filename) {
        try {
            const imageBuffer = fs.readFileSync(`${this.fp}/${filename}.jpg`);
            const messages = this.agent.history.getHistory();

            const blockInfo = this.getCenterBlockInfo();
            const result = await this.agent.prompter.promptVision(messages, imageBuffer);
            return result + `\n${blockInfo}`;

        } catch (error) {
            console.warn('Error reading image:', error);
            return `Error reading image: ${error.message}`;
        }
    }
}
