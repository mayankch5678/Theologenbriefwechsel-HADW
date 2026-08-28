# THBW RAG 评测题集（59 题）

> 更新：2026-08-28（第四轮：rerank + chunk 索引后）
> 
> 金标全部来自编辑手工维护的数据（主题标签 / 规范收发人名 / 日期），不依赖 AI。
> 重新生成：`npm run build:gold && npm run build:questions`；运行：`npm run eval`（检索，秒级）/ `npm run eval:full`（含 DeepSeek + 人工审阅表）。

## 一、手写题（9 道）

| # | 题目 | 考点 | 召回 | 精确 | 来源数 |
|---|---|---|---|---|---|
| 1 | Welche Briefe erwähnen den Heidelberger Katechismus? | 枚举：46 封金标 | 100.0% | 86.8% | 53 |
| 2 | Welche Briefe betreffen Frage 60 des Heidelberger Katechismus? | 变体标签：必须命中 25851 | ✓ | — | 57 |
| 3 | Welche Briefe schrieb Kaspar Olevian an Heinrich Bullinger? | 人物：收发双方交集 | 100.0% | 27.3% | 11 |
| 4 | Welche Briefe stammen aus dem Jahr 1563? | 年份：384 封金标，确定性路径 | 100.0% | 97.0% | 396 |
| 5 | Wer schickte Calvin die lateinische Übersetzung des Heidelberger Katechismus? | 单事实：必须命中 18495 | ✓ | — | 131 |
| 6 | Hallo, wie geht es dir? | 闲聊：期望 0 来源 + 拒答 | 0 ✓ | — | 0 |
| 7 | Was ist das beste Rezept für Pizza? | 域外：期望 0 来源 + 拒答 | 0 ✓ | — | 0 |
| 8 | Wie viele Briefe enthält das Archiv insgesamt? | 对抗：全库统计 → 拒答 | — | — | 3 |
| 9 | Fasse den Brief 99999 zusammen. | 对抗：不存在的信 → 0 来源 + 拒答 | 0 ✓ | — | 0 |

## 二、模板题·主题类（34 道）

随机抽样主题标签（挂 3–60 封公开信），金标 = 挂该标签的公开信。

| # | 题目 | 金标数 | 召回 | 精确 | 引用召回 | 来源数 |
|---|---|---|---|---|---|---|
| 1 | Welche Briefe erwähnen 1 Sam 4? | 3 | 100.0% | 100.0% | 100.0% | 3 |
| 2 | Welche Briefe erwähnen Junius, Animadversiones ad controversiam primam, 1600 (Index Aureliensis 157.193)? | 4 | 100.0% | 100.0% | 100.0% | 4 |
| 3 | Welche Briefe erwähnen Psalmenkommentar? | 9 | 100.0% | 69.2% | 100.0% | 13 |
| 4 | Welche Briefe erwähnen Stuhlgang? | 5 | 100.0% | 100.0% | 100.0% | 5 |
| 5 | Welche Briefe erwähnen Interim in Mömpelgard? | 19 | 100.0% | 95.0% | 100.0% | 20 |
| 6 | Welche Briefe erwähnen Religionsgespräch von Poissy (1561)? | 42 | 100.0% | 100.0% | 100.0% | 42 |
| 7 | Welche Briefe erwähnen Resignation einer Stelle? | 20 | 100.0% | 100.0% | 100.0% | 20 |
| 8 | Welche Briefe erwähnen Mäzen? | 17 | 100.0% | 100.0% | 100.0% | 17 |
| 9 | Welche Briefe erwähnen Biblia complutensis (1514-1517)? | 3 | 100.0% | 100.0% | 100.0% | 3 |
| 10 | Welche Briefe erwähnen Kirchenvisitation im Herzogtum Pfalz-Zweibrücken? | 19 | 100.0% | 79.2% | 100.0% | 24 |
| 11 | Welche Briefe erwähnen Private Verbreitung von Schriften? | 16 | 100.0% | 100.0% | 100.0% | 16 |
| 12 | Welche Briefe erwähnen Frischlin, Nicodemus Frischlinus Redivivus, 1599 (VD16 F 2902)? | 3 | 100.0% | 27.3% | 100.0% | 11 |
| 13 | Welche Briefe erwähnen Cicero, De officiis? | 3 | 100.0% | 75.0% | 100.0% | 4 |
| 14 | Welche Briefe erwähnen Supernova 1572? | 5 | 100.0% | 100.0% | 100.0% | 5 |
| 15 | Welche Briefe erwähnen Weininger, Ein Predigt, Von Christo dem Breutigam? | 4 | 100.0% | 100.0% | 100.0% | 4 |
| 16 | Welche Briefe erwähnen Röm 1? | 7 | 100.0% | 22.6% | 100.0% | 31 |
| 17 | Welche Briefe erwähnen Falsche Schlussfolgerung? | 5 | 100.0% | 100.0% | 100.0% | 5 |
| 18 | Welche Briefe erwähnen Goldschmuck? | 4 | 100.0% | 100.0% | 100.0% | 4 |
| 19 | Welche Briefe erwähnen Meierhof? | 4 | 100.0% | 100.0% | 100.0% | 4 |
| 20 | Welche Briefe erwähnen Englischer Kleiderstreit? | 18 | 100.0% | 100.0% | 100.0% | 18 |
| 21 | Welche Briefe erwähnen Ferrarisch-Württembergische Beziehungen? | 3 | 100.0% | 100.0% | 100.0% | 3 |
| 22 | Welche Briefe erwähnen essentia? | 9 | 100.0% | 100.0% | 100.0% | 9 |
| 23 | Welche Briefe erwähnen Briefe Vermiglis? | 4 | 100.0% | 33.3% | 100.0% | 12 |
| 24 | Welche Briefe erwähnen Strafandrohung? | 13 | 100.0% | 100.0% | 100.0% | 13 |
| 25 | Welche Briefe erwähnen Außereheliche Beziehungen? | 3 | 100.0% | 100.0% | 100.0% | 3 |
| 26 | Welche Briefe erwähnen Buch Rut? | 5 | 100.0% | 100.0% | 100.0% | 5 |
| 27 | Welche Briefe erwähnen Steirer Kirche? | 13 | 100.0% | 65.0% | 100.0% | 20 |
| 28 | Welche Briefe erwähnen Sodomiten? | 4 | 100.0% | 100.0% | 100.0% | 4 |
| 29 | Welche Briefe erwähnen Theologielektur? | 8 | 100.0% | 100.0% | 100.0% | 8 |
| 30 | Welche Briefe erwähnen Brandenburg-Nürnbergische Kirchenordnung (1533)? | 12 | 100.0% | 92.3% | 100.0% | 13 |
| 31 | Welche Briefe erwähnen Spaziergang? | 10 | 100.0% | 100.0% | 100.0% | 10 |
| 32 | Welche Briefe erwähnen Paracelsus, Astronomia Magna, 1571 (VD16 P 401)? | 3 | 100.0% | 60.0% | 100.0% | 5 |
| 33 | Welche Briefe erwähnen Steuerwesen im Osmanischen Reich? | 3 | 100.0% | 100.0% | 100.0% | 3 |
| 34 | Welche Briefe erwähnen Kolloquenten des Wormser Religionsgesprächs (1557)? | 3 | 100.0% | 25.0% | 100.0% | 12 |

## 三、模板题·人物类（15 道）

随机抽样往来 ≥3 封的收发人对，金标 = 该方向全部公开信（含 [方括号] 推定变体）。

| # | 题目 | 金标数 | 召回 | 精确 | 引用召回 | 来源数 |
|---|---|---|---|---|---|---|
| 1 | Welche Briefe schrieb Ambrosius Blarer an Konrad Hubert? | 31 | 100.0% | 49.2% | 96.8% | 63 |
| 2 | Welche Briefe schrieb Simon Sulzer an Johannes Kessler? | 3 | 100.0% | 60.0% | 100.0% | 5 |
| 3 | Welche Briefe schrieb Ludwig, Herzog von Württemberg an Württembergische Kirchenräte? | 7 | 100.0% | 17.1% | 85.7% | 41 |
| 4 | Welche Briefe schrieb Ottheinrich, Herzog von Pfalz-Neuburg an Martin Bucer? | 5 | 100.0% | 50.0% | 100.0% | 10 |
| 5 | Welche Briefe schrieb Nikolaus Thomae an Konrad Hubert, Diakon an St. Thomas? | 6 | 100.0% | 85.7% | 100.0% | 7 |
| 6 | Welche Briefe schrieb David Pareus an Johannes Piscator? | 10 | 100.0% | 71.4% | 100.0% | 14 |
| 7 | Welche Briefe schrieb Zacharias Ursinus an Heinrich Bullinger? | 23 | 100.0% | 88.5% | 100.0% | 26 |
| 8 | Welche Briefe schrieb Zacharias Ursinus an Johannes Crato von Krafftheim? | 42 | 100.0% | 93.3% | 100.0% | 45 |
| 9 | Welche Briefe schrieb Johannes Forster an Johannes Schradin? | 9 | 100.0% | 90.0% | 100.0% | 10 |
| 10 | Welche Briefe schrieb Julius Friedrich, Herzog von Württemberg-Weiltingen, Vormund und Administrator an Melchior Nicolai, Superattendent? | 5 | 100.0% | 25.0% | 80.0% | 20 |
| 11 | Welche Briefe schrieb Timotheus Kirchner, Rektor der Universität Heidelberg an Johann Casimir, Administrator der Kurpfalz? | 3 | 100.0% | 12.0% | 100.0% | 25 |
| 12 | Welche Briefe schrieb Sophia Jagiellonica, Herzogin von Braunschweig-Wolfenbüttel an Jakob Andreae? | 6 | 100.0% | 33.3% | 100.0% | 18 |
| 13 | Welche Briefe schrieb Jakob Andreae an Philipp Ludwig, Herzog von Pfalz-Neuburg? | 8 | 100.0% | 53.3% | 100.0% | 15 |
| 14 | Welche Briefe schrieb David Chytraeus (d. Ä.) an Jakob Andreae? | 6 | 100.0% | 60.0% | 100.0% | 10 |
| 15 | Welche Briefe schrieb Ludwig, Herzog von Württemberg an Jakob Schropp, Abt zu Maulbronn? | 14 | 100.0% | 28.0% | 100.0% | 50 |
