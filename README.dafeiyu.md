# 大肥鱼定制版 · dafeiyu-orb

这是 [`dsh-orb`](https://github.com/mini-yifan/dsh-orb)（悬浮球 Agent 插件）的个人定制分支，
上游为 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方衍生作品。
原作者与版权声明见 [`LICENSE`](./LICENSE) 与 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)，本仓库未做任何改动。

相对上游的两处改动：

| 改动 | 位置 | 说明 |
|---|---|---|
| 自训练唤醒词「大肥鱼」 | `dsh_orb/wake_*.py`、`dsh-voice-dialog/assets/dafeiyu.onnx` | 用 Edge TTS 合成正样本 + openWakeWord 预训练特征提取，导出单层分类器替换 `hey_jarvis` |
| 语音播报表情槽位 `speak` | `packages/helper/`、`memes.json` | 播放语音回复时切到「说话」GIF，区分于用户听写（`voice`）与流式吐字（`reply`） |

## 唤醒词训练

```bash
python dsh_orb/wake_pipeline.py     # 六阶段流水线：合成 → 提特征 → 训练 → 导出 → 评估
```

训练环境的 Python/CUDA 环境名为 `indextts`（复用自另一个项目），**实际 TTS 用的是 Edge TTS**。

一个容易踩的坑：openWakeWord 的分类器吃的是 16 维 embedding 环形缓冲，
真机运行前该环已被约 3.2 秒上下文填满，而零填充或冷启动特征训练出来的模型
会对普通中文大量误触发。`wake_features.py` 里的 warm-up 就是为此存在——
**改动特征提取逻辑时务必保持与 `packages/helper/assets/wake.js` 的 `FRAME_SIZE = 1280` @ 16 kHz 一致。**

## 素材包

`大肥鱼表情包整合/` 是第三方 GIF 素材（约 274 MB，212 个文件），仅供个人使用，
其著作权属于各自作者。`memes.json` 的 `dir` 需指向该目录的上层路径。

`dsh-voice-dialog/assets/ort/`（onnxruntime-web，MIT）不入库，需从 CDN 获取。

## 本机相关

`dsh_orb/` 下的探针与打包脚本包含硬编码的 Windows 绝对路径，换机器需自行调整。
真正通用的部分是 `wake_*.py`。

## 开发

```bash
pnpm install
pnpm build
pnpm test
```

Windows 上测试需注意 Node 版本差异，`--test-isolation=process` 在 Node 22.22.2 下不识别。

MIT License，继承自上游。