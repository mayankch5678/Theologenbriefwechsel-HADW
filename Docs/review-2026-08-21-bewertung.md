# 人工评审记录 · 2026-08-21（59 题，评审人：Zonghan Jia）

> 对应代码状态：eval-harness 分支 commit `1719dd5` 之前（第三轮修复前）。自动检查全绿的情况下人读了全部 59 个回答。

## 总评

整体质量很高，但有 2 个硬伤、2 个小毛病。59 个回答里约 54 个可以直接打 gut：列举准确、元数据（发件人/收件人/日期）没有发现编造、(nur Metadaten) 标记诚实，还频繁出现高质量的主动辨析（olevian 问题里指出来信 38867 方向反了；Bonn 问题里区分 1583 和 1588 两次围城；Melanchthon 问题里排除 Schnepf→Melanchthon 方向的信）。smalltalk / offtopic / 统计题 / 不存在的 Brief 99999 四个防幻觉测试全部正确拒答。

## 硬伤（同一类失败：检索找对了，模型不认——自动检查看不到）

1. **de_variant_frage60 — 假拒答，最严重。** 回答"所提供的信件中没有一封提及第 60 问"，但 25851 就在 57 个源里且在 prompt 里（57 < 60）。语料记录标签行明确写着 "Heidelberger Katechismus, Frage 60"，regest 也写着"对称义的正确理解也通过《海德堡要理问答》得到确认"（Frage 60 正是称义问题）。逃过自动检查的原因：falseRefusal / citationRecall 只对 goldList 题计算，mustInclude 题完全不做生成端检查。
2. **gen_sache_89066c（Falsche Apostel）— 错误否认。** 回答声称 33960 不含此关键词，但 33960 的标签里就有 "Falsche Apostel"（该标签全库 3 封：17969、77325、33960）。33960 挂了 42 个标签，标签行太长模型没扫到——和 25851（20 个标签）同一失败签名。

## 小毛病

- gen_person_06（August → Andreae）：列举 25 封后截断，漏了上下文里另外约 17 封；第 25 条 59681 方向引反（那是 Andreae 写给 August 的访问报告）。
- gen_person_12（Johann Friedrich → Hafenreffer）：citation recall 0% 是金标方括号问题——模型引的 7 封和 gold 的 4 封是同一组通信，gold 用 combi 精确匹配只抓到不带方括号的变体。答案实质正确，指标误报。

## 核过的"疑似编造"，最终都是模型对

- de_enum 里多出的 25951：regest 原文引用了 "[HK, Frage 1]"，编辑部没打标签——答案比 gold 还全。
- 21237：标签含 "Catechesis religionis christianae, 1563"（海德堡要理问答拉丁版书名），识别正确。
- de_enum_heidelberg 可放心打 gut：46/46 gold 全引，多出的 2 条都有据可查。

## 对 harness 的建议（已于同日落地）

1. mustInclude 题也加生成端检查（citationRecall / falseRefusal）。
2. citationRecall 的分母不能假设金标排在源列表前 60 位（person_12 有 261 个源）。

## 后续（2026-08-28 第二次评审要点）

- 评测方法论盲区：金标 100% 来自标签，召回 100% 是"定义上的"；"相关但没打标签"的信被算成噪声。建议建"regest 有、标签没有"的内容型金标题。
- 拒答重试护栏副作用：重试后回答以 "Entschuldigung für den Fehler" 开头。
- 引导句自相矛盾：先说"没有一封提到 Genf"，列表里 81935 就写着 Erdbeben in Genf。
- 延迟：内容题 13 秒、枚举题 20 秒以上，无进度提示。
