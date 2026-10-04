"""What gets said during training, and what the model must learn to ignore.

Kept apart from the generator because these lists are the part that gets tuned by ear: a wake word
lives or dies on its near-misses, and the pair that matters is 大肥鱼 against whatever a Mandarin
speaker would actually confuse it with. Collecting them in one place makes that list reviewable.
"""

from __future__ import annotations

# The wake word. TTS pronounces an invented phrase inconsistently, so a variant that comes back wrong
# is dropped by listening rather than guessed at — see the `probe` command in wake_tts.py.
POSITIVE = [
    "大肥鱼",
]

# Carrier phrases: the same word with company around it, so the model learns the word rather than
# "the clip begins here". Slots are filled with a random prefix at generation time.
POSITIVE_CARRIERS = [
    "大肥鱼",
    "喂，大肥鱼",
    "大肥鱼，在吗",
    "那个，大肥鱼",
    "嗯，大肥鱼",
]

# Near-misses. These are the whole difficulty of the task: every one of them is a phrase the user
# might say in ordinary conversation, and every one shares most of its phones with the wake word.
# 大肥猪 dà féi zhū and 大飞鱼 dà fēi yú are one feature apart from 大肥鱼 dà féi yú.
ADVERSARIAL = [
    "大肥猪",
    "大飞鱼",
    "大白鱼",
    "大肥鹅",
    "大肥牛",
    "大肥羊",
    "大肥猫",
    "大鲤鱼",
    "打肥鱼",
    "搭飞机",
    "打飞机",
    "发呆鱼",
    "大肺鱼",
    "带鱼",
    "肥鱼",
]

# Ordinary Chinese sentences. In real use the wake word is surrounded by talk, so this is where the
# false-accept rate is really decided — not by the near-misses above, which are chosen adversarially
# and are therefore rare, but by the fact that somebody is talking at all.
FILLER = [
    "今天天气不错，我们出去走走吧。",
    "帮我查一下明天的会议安排。",
    "这个功能什么时候能做好？",
    "我想吃点东西，你推荐一下。",
    "把刚才那段话重新读一遍。",
    "明天早上八点叫醒我。",
    "这个文件放在哪个目录里了？",
    "现在几点了？",
    "声音大一点，我听不清楚。",
    "帮我记一下，下午三点开会。",
    "这段代码为什么会报错？",
    "打开浏览器，搜索一下这个词。",
    "我昨天买的那个东西到了没有？",
    "你觉得这个方案可行吗？",
    "先等一下，我还有话要说。",
    "把屏幕亮度调低一点。",
    "这个东西多少钱？",
    "我们下周再讨论这个问题。",
    "你有没有看到我的钥匙？",
    "外面好像要下雨了。",
    "这个月的工作安排得怎么样？",
    "我一会儿再回复你。",
    "麻烦把窗户关上。",
    "这两件事哪个更重要？",
    "我记得好像不是这样。",
    "你先试一下看看效果。",
    "我们十分钟以后开始。",
    "这个东西放在哪里比较合适？",
    "刚才那条消息是什么意思？",
    "我把资料发给你了，注意查收。",
    "今天的任务差不多完成了。",
    "你帮我看看这里有没有问题。",
    "我想再考虑一下。",
    "时间过得真快。",
    "这个价格有点贵。",
    "附近有没有吃饭的地方？",
    "别忘了带伞。",
    "我打算明天去一趟。",
    "他说的话我一句也没听懂。",
]
