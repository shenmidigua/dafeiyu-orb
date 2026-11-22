"""What gets said during training, and what the model must learn to ignore.

Kept apart from the generator because these lists are the part that gets tuned by ear: a wake word
lives or dies on its near-misses, and the pair that matters is 大肥鱼 against whatever a Mandarin
speaker would actually confuse it with. Collecting them in one place makes that list reviewable.
"""

from __future__ import annotations

# The wake word. TTS pronounces an invented phrase inconsistently, so a variant that comes back wrong
# is dropped by listening rather than guessed at — see the `probe` command in wake_tts.py.
# The wake word. Said **twice, without a pause** — the repeat is the point, not emphasis: a single
# 大肥鱼 fires constantly on ordinary Mandarin, and requiring the pair roughly squares the chance of
# an accidental match.
#
# Nothing here may put a *suffix* after the phrase. A positive clip is trimmed at its own speech end
# so the trainer knows where the phrase finishes (`wake_dataset.prepare_positive`), and a suffix would
# make "the end of the talking" and "the end of the wake word" two different places.
POSITIVE = [
    "大肥鱼大肥鱼",
]

# Carrier phrases: the same words with company in front, so the model learns the phrase rather than
# "the clip begins here". Prefixes only, for the reason above.
POSITIVE_CARRIERS = [
    "大肥鱼大肥鱼",
    "喂，大肥鱼大肥鱼",
    "那个，大肥鱼大肥鱼",
    "嗯，大肥鱼大肥鱼",
    "来，大肥鱼大肥鱼",
]

# Near-misses. These are the whole difficulty of the task: every one of them is a phrase the user
# might say in ordinary conversation, and every one shares most of its phones with the wake word.
# 大肥猪 dà féi zhū and 大飞鱼 dà fēi yú are one feature apart from 大肥鱼 dà féi yú.
#
# The first group is the one that matters most, and it is the change. Now that the wake word is the
# *doubled* phrase, 大肥鱼 said **once** — alone or buried in a sentence — is the most likely thing
# the model will confuse it with, and getting that wrong is exactly the bug this fixes. These are not
# near-misses any more; they are the primary adversary, and they are synthesised as whole clips
# rather than cut from paragraphs so that exactly one instance is present in each.
DOUBLED_MISREADS = [
    "大肥鱼",
    "喂，大肥鱼",
    "大肥鱼在吗",
    "那个大肥鱼呢",
    "我看到一条大肥鱼",
    "这条大肥鱼真不错",
    "我昨天钓上来一条大肥鱼",
]

# The same adversary in more of the shapes Mandarin actually puts it in — a *family*, not a longer
# list of phrases, and the distinction is the whole point of the group.
#
# What the model did with the seven above is the evidence. `dsh_orb/wake_candidate_probe.py` scored
# every one of them, in fourteen voices and three rates, against the shipped three-window rule:
#
#     喂，大肥鱼     trained    peak 0.994   longest run 2   0/42 clips fired
#     嗯，大肥鱼     not trained peak 0.999   longest run 5   1/42 clips fired
#     那个，大肥鱼   not trained peak 1.000   longest run 6   3/42 clips fired
#
# The ear hears one phrase three times. The model held the line on the one it had been shown and gave
# way on the two it had not, which is what memorising a list looks like from the outside. Adding more
# phrases of the *same* kind would repeat that mistake at a larger size: the model has to learn "the
# word is said twice", and a rule is only learnable from its variations.
#
# So the axes here are the ones that vary in speech — which interjection, whether the pause is written
# as a comma, and whether the word leads or is buried — and every one of them is a minimal pair with a
# shipped carrier phrase (`POSITIVE_CARRIERS`), so the only thing separating positive from negative in
# the pair is the second repetition.
SINGLE_WORD_SHAPES = [
    # Interjection plus comma. 嗯/那个/来/喂 appear on the carrier list too, which is deliberate:
    # 嗯，大肥鱼 against 嗯，大肥鱼大肥鱼 is the cleanest single teaching example the data can carry.
    "嘿，大肥鱼",
    "嗯，大肥鱼",
    "诶，大肥鱼",
    "哎，大肥鱼",
    "哟，大肥鱼",
    "呃，大肥鱼",
    "好，大肥鱼",
    "来，大肥鱼",
    "那个，大肥鱼",
    "这个，大肥鱼",
    "我说，大肥鱼",
    # The same, with the pause written as nothing. Synthesised as one run, this is the reading closest
    # to the doubled phrase and therefore the hardest negative in the list.
    "嘿大肥鱼",
    "嗯大肥鱼",
    "诶大肥鱼",
    "那个大肥鱼",
    "这个大肥鱼",
    # Trailing particles. Allowed here and forbidden on the carriers, for the reason given there: a
    # positive is trimmed at its own speech end, a negative is a whole clip.
    "大肥鱼呢",
    "大肥鱼啊",
    "大肥鱼吗",
    "大肥鱼你好",
    "大肥鱼在不在",
    # Buried in a sentence, exactly one occurrence — how the word shows up when it is being talked
    # about rather than talked to.
    "我要叫大肥鱼",
    "这是大肥鱼的声音",
    "大肥鱼是谁",
    "大肥鱼好玩吗",
    "把大肥鱼叫过来",
    "大肥鱼今天怎么样",
    "你说大肥鱼",
    "我找大肥鱼",
]

# Truncations of the *doubled* phrase — the family the two groups above do not cover, and the one the
# user actually reported.
#
# `DOUBLED_MISREADS` and `SINGLE_WORD_SHAPES` both attack the phrase said **once**: 大肥鱼,
# 喂，大肥鱼, 大肥鱼在吗. A truncation is not that. 「大肥大肥」 and 「大肥鱼大肥」 are still said twice —
# the same utterance with a syllable missing — so a model that holds the line on the phrase said once
# can still fail on them, which is what a classifier that learned "大肥 comes round again" looks like
# rather than one that learned "大肥鱼 twice".
#
# Measured before adding them, against the deployed model, with `wake_truncation_probe.py`:
#
#     大肥鱼大肥鱼   peak 1.000   longest run 10   FIRES   <- the phrase, for reference
#     大肥大肥       peak 1.000   longest run  4   FIRES   <- 鱼 dropped from both halves
#     大肥鱼大肥     peak 1.000   longest run  3   FIRES   <- the final 鱼 dropped
#     肥鱼大肥鱼     peak 1.000   longest run  7   FIRES   <- the leading 大 dropped
#
# Four of the six peaked at 1.000 and the other two at 0.997 and 0.999 — all of them within a rounding
# error of the phrase's own peak, so **no threshold can separate them**, at either end of the clamp.
# And the longest run reached seven windows against a rule that asks for three, so asking for more
# consecutive windows would spend a second of latency to stop a truncation said slowly. The rule
# cannot fix this; only the model can, and only by being shown the family.
#
# The axes are the ones a syllable can go missing along — **which** syllable, **which half**, and how
# many are left — because a rule is only learnable from its variations, and seven phrases differing
# along three axes are a rule while seven phrases of one shape are a list.
TRUNCATED_DOUBLES = [
    # Both halves lose the same syllable: four syllables, still said twice, and the hardest reading to
    # tell from the phrase because the rhythm of the utterance is unchanged.
    "大肥大肥",     # 鱼 鱼 — the user's first report
    "大鱼大鱼",     # 肥 肥 — the other syllable a speaker swallows
    # One half loses one syllable: five syllables, the phrase one word short. Both sides are here on
    # purpose. The deployed model was already quiet on 肥大肥鱼 (longest run 1) and loud on 大肥鱼肥鱼
    # (longest run 6) — the same question, answered two ways, which is what an unshown axis looks like
    # from the outside and the reason neither side can be left out.
    "大肥鱼大肥",   # _ 鱼 — the user's second report
    "大肥大肥鱼",   # 鱼 _ — the same truncation on the other side
    "肥鱼大肥鱼",   # 大 _ — the leading 大 dropped
    "大肥鱼肥鱼",   # _ 大 — the second half's 大 dropped
    # Both halves lose a syllable, but not the same one — the point neither symmetric entry reaches.
    "大肥大鱼",     # 鱼 from the first half, 肥 from the second
]

# Interruptions of the *doubled* phrase — the third family, reported by the user after the truncations
# were fixed: 「大肥鱼一二三大肥鱼」 woke the orb.
#
# It is not a truncation and not a single word. Both halves are present, complete and in order; what is
# wrong is that they are not **adjacent**. The ring is 28 slots and the utterance is about 2.7 s, so the
# whole thing fits inside one window and the classifier sees 大肥鱼 … 一二三 … 大肥鱼 as a single
# object — and nothing in the training set ever said that the two halves have to touch. The positive
# rule is containment (a window is positive once it has reached the phrase's end), and a window holding
# an interrupted double has reached the phrase's end, so the rule as it stands calls it positive.
#
# Measured on the deployed model before adding them, with `wake_truncation_probe.py --voices 5
# --tries 10`. `needs` is the threshold that would exclude the phrase, i.e. the minimum of its best
# three-window run, worst case over voices and contexts; the helper clamps at 0.99:
#
#     大肥鱼嗯大肥鱼       peak 1.000  run 7  5/5 voices fire   needs 1.000
#     大肥鱼那个大肥鱼     peak 1.000  run 4  3/5 voices fire   needs 1.000
#     大肥鱼然后大肥鱼     peak 1.000  run 4  1/5 voices fire   needs 1.000
#     大肥鱼是不是大肥鱼   peak 1.000  run 6  3/5 voices fire   needs 1.000
#     大肥鱼一二大肥鱼     peak 1.000  run 6  1/5 voices fire   needs 0.998
#     大肥鱼一二三四五大肥鱼 peak 1.000 run 3  1/5 voices fire   needs 0.977
#     大肥鱼一二三大肥鱼   peak 1.000  run 2  0/5 voices fire   needs 0.057
#     ────────────────────────────────────────────────────────────────────────
#     6/8 fire
#
# Four of them need 1.000: the score is saturated, so **no setting of the white line can reach them**.
# That is what makes this a data problem rather than a tuning problem, and it is the same shape as the
# truncations — the model was never shown the family, so it has no reason to reject it.
#
# A pause is not the answer either, and the temptation is worth writing down because it is the natural
# one: 「停顿 + 大肥鱼大肥鱼」 does not separate these, because the insertion is *inside* the ring. The
# window ends at "now", so silence in front of the utterance only occupies the window's left edge, and
# once the lead-in is longer than the room left in the window the classifier is handed a byte-identical
# input. Worse, the model fires on the phrase with talking right up to it (half the training warm-ups
# are speech), so a pause gate would be a *new* requirement rather than a tighter version of an old
# one. `wake_pause_probe.py` measures both halves of that.
#
# The axes are the ones an interruption varies along — **what** is inserted (a count, a filler word, a
# hesitation, a conjunction, a question tag), **how long** the insertion is, and whether the pause
# around it is written — because a rule is only learnable from its variations, and the longest entry
# here is deliberately past what the ring can hold, which makes it a truncation of the *first* half
# rather than an interruption at all.
INTERRUPTED_DOUBLES = [
    "大肥鱼一二三大肥鱼",       # counting between the halves — the user's report
    "大肥鱼一二大肥鱼",         # the same, shorter
    "大肥鱼一二三四五大肥鱼",   # the same, longer than the ring: the first half falls out of the window
    "大肥鱼那个大肥鱼",         # a filler word
    "大肥鱼，那个，大肥鱼",     # the same filler, with the pauses written
    "大肥鱼嗯大肥鱼",           # a hesitation
    "大肥鱼然后大肥鱼",         # a conjunction
    "大肥鱼是不是大肥鱼",       # a question tag
]

ADVERSARIAL = (DOUBLED_MISREADS + SINGLE_WORD_SHAPES + TRUNCATED_DOUBLES + INTERRUPTED_DOUBLES + [
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
])

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

# ------------------------------------------------------------------------------------------------
# 别的唤醒词：同一套家族，按每个名字自己的音节写出来
#
# 一个唤醒词不是一个字符串，而是一个家族——「说一遍」「漏一个音节」「两半之间插话」「同音字」
# 四组必须一起到场，否则模型记住的是清单而不是规则。大肥鱼那几轮就是这么过来的：第 111 行起
# 记着每漏掉一组要付什么代价，这里不再重复论证，只照那套骨架给另外三个名字各自写一份。
#
# 三个名字都是两字名叠一遍（四个音节），比「大肥鱼大肥鱼」短，同一只 28 槽的环装得下；不同的
# 地方在音节结构，所以漏音节的形状按各自的两个字拼出来，而不是从大肥鱼那七条里改名字。
#
# 同音字那一组是各写各的，模板写不出「小弟」和「小弟弟」之间的距离——那三个字里有一个是真词，
# 是这三个名字里最难的一条负样本，模型没有理由拒绝它，除非它被见过。
# ------------------------------------------------------------------------------------------------

# 说一遍的各种样子。逗号写与不写是两条：不写的那条念起来最接近叠词，也就是最难的那条负样本。
_SINGLE_SHAPES = [
    "{n}",
    "嘿，{n}",
    "嗯，{n}",
    "诶，{n}",
    "那个，{n}",
    "我说，{n}",
    "{n}呢",
    "{n}啊",
    "{n}吗",
    "{n}你好",
    "{n}在不在",
    "我要叫{n}",
    "这是{n}的声音",
    "{n}是谁",
    "{n}好玩吗",
    "把{n}叫过来",
    "{n}今天怎么样",
    "你说{n}",
    "我找{n}",
    # 停顿不写成一个逗号：同一个意思，离叠词更近一步
    "嘿{n}",
    "嗯{n}",
    "那个{n}",
]

# 两半之间插话。不插话的两半是叠词，插了话的仍然是两半——这正是要教的那条规则。
_INTERRUPTED_SHAPES = [
    "{d}一二三{d}",
    "{d}一二{d}",
    "{d}那个{d}",
    "{d}，那个，{d}",
    "{d}嗯{d}",
    "{d}然后{d}",
    "{d}是不是{d}",
]

# 正样本的外框：同一个名字，前面带一次招呼。只放前缀——正样本按自己说完的那一帧裁开
# （`wake_dataset.prepare_positive`），后缀会让「说完」和「唤醒词说完」变成两个位置。
_CARRIER_SHAPES = [
    "{d}",
    "喂，{d}",
    "那个，{d}",
    "嗯，{d}",
    "来，{d}",
]


def _truncations(name: str) -> list:
    """漏掉一个音节的叠词。

    两字名叠一遍是四个音节，漏一个就剩三个。漏哪一个、漏在前半还是后半，是三个轴，四条
    把每种组合都说到；对称地只写一两条，模型就只会拒绝那一侧。
    """
    first, second = name[0], name[1]
    return [
        f"{first}{second}{first}",   # 最后那个字掉了
        f"{first}{first}{second}",   # 前半句掉了第二个字
        f"{second}{first}{second}",  # 最前面那个字掉了
        f"{first}{second}{second}",  # 后半句掉了第一个字
    ]


def _family(name: str, confusions: list) -> dict:
    doubled = name + name
    return {
        "positive": [doubled],
        "carriers": [shape.format(d=doubled) for shape in _CARRIER_SHAPES],
        "adversarial": (
            [shape.format(n=name) for shape in _SINGLE_SHAPES]
            + _truncations(name)
            + [shape.format(d=doubled) for shape in _INTERRUPTED_SHAPES]
            + list(confusions)
        ),
    }


# 每个名字最贴近的同音字。列的是「用普通话说这句话时，嘴和耳朵都容易混成它」的字，不是随便
# 换成另一个汉字——同音字这一组离正样本越近，边界才越准，离得远的那一组只是凑数。
XIAODI = _family("小弟", [
    "小迪", "小笛", "小敌", "小底", "小递",
    "小弟弟",   # 真词，也是三个名字里最难的一条负样本
    "小妹妹",
    "晓弟",
])

XIAOHUI = _family("小慧", [
    "小会", "小惠", "小灰", "小辉", "小回", "小绘",
    "晓慧",
    "小慧慧",
])

DACHENG = _family("大成", [
    "大城", "大诚", "大程", "大呈", "大橙", "大乘",
    "达成",   # 它本身也是一个常用词，会被说得比名字更随意
    "大成成",
])


def profile(keyword: str) -> dict:
    """The three lists a keyword's training set is built from.

    Every keyword the orb offers has to be here, because the dataset is generated from this table
    and nothing else: a keyword missing from it is a keyword that cannot be trained, which is the
    failure mode this function exists to make loud rather than quiet.
    """
    found = PROFILES.get(keyword)
    if found is None:
        raise SystemExit(f"no phrase profile for {keyword!r}; known: {sorted(PROFILES)}")
    return found


# 关键字 → 一份家族。dafeiyu 用的是上面手写的那几组，其余三个是这里生成的。
PROFILES = {
    "dafeiyu": {
        "positive": POSITIVE,
        "carriers": POSITIVE_CARRIERS,
        "adversarial": ADVERSARIAL,
    },
    "xiaodi": XIAODI,
    "xiaohui": XIAOHUI,
    "dacheng": DACHENG,
}

# 中文名字，给菜单和设置页用。放在这里而不是页面里，是因为它必须和上面那张表一起改：
# 一个能训练的名字，就应该是一个能显示、能选的名字。
DISPLAY_NAMES = {
    "dafeiyu": "大肥鱼",
    "xiaodi": "小弟",
    "xiaohui": "小慧",
    "dacheng": "大成",
}
