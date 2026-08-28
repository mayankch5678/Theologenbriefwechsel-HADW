# THBW RAG 评测题集（65 题）

> 更新：2026-08-28（第五轮：regest 路径 + 内容型题后）
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

## 二、模板题·主题类（33 道）

随机抽样主题标签（挂 3–60 封公开信），金标 = 挂该标签的公开信。

| # | 题目 | 金标数 | 召回 | 精确 | 引用召回 | 来源数 |
|---|---|---|---|---|---|---|
| 1 | Welche Briefe erwähnen Verwalter? | 60 | 100.0% | 100.0% | 100.0% | 60 |
| 2 | Welche Briefe erwähnen Erbhuldigung? | 6 | 100.0% | 100.0% | 100.0% | 6 |
| 3 | Welche Briefe erwähnen Hafer? | 56 | 100.0% | 87.5% | 100.0% | 64 |
| 4 | Welche Briefe erwähnen Apostasie? | 14 | 100.0% | 35.0% | 100.0% | 40 |
| 5 | Welche Briefe erwähnen Bischofswahl? | 11 | 100.0% | 100.0% | 100.0% | 11 |
| 6 | Welche Briefe erwähnen Erastus, Theses de Morbis Totius Substantiae, 1575? | 4 | 100.0% | 11.1% | 100.0% | 36 |
| 7 | Welche Briefe erwähnen Leipziger Herbstmesse? | 5 | 100.0% | 62.5% | 100.0% | 8 |
| 8 | Welche Briefe erwähnen 2. Buch der Chronik? | 5 | 100.0% | 100.0% | 100.0% | 5 |
| 9 | Welche Briefe erwähnen Gedichtsammlung? | 5 | 100.0% | 62.5% | 100.0% | 8 |
| 10 | Welche Briefe erwähnen Italienische Fremdengemeinde in Genf? | 15 | 100.0% | 16.9% | 100.0% | 89 |
| 11 | Welche Briefe erwähnen Ohnmacht? | 7 | 100.0% | 100.0% | 100.0% | 7 |
| 12 | Welche Briefe erwähnen Unterwelt? | 5 | 100.0% | 55.6% | 100.0% | 9 |
| 13 | Welche Briefe erwähnen Philipperbrief? | 6 | 100.0% | 100.0% | 100.0% | 6 |
| 14 | Welche Briefe erwähnen Verweis aus der Klosterschule? | 3 | 100.0% | 60.0% | 100.0% | 5 |
| 15 | Welche Briefe erwähnen Danaeus, Antiosiander, Genf 1580 (GLN-2788)? | 3 | 100.0% | 50.0% | 100.0% | 6 |
| 16 | Welche Briefe erwähnen Heidelberger Theologen? | 3 | 100.0% | 3.3% | 100.0% | 91 |
| 17 | Welche Briefe erwähnen Zufall? | 4 | 100.0% | 10.3% | 100.0% | 39 |
| 18 | Welche Briefe erwähnen Moralphilosophie? | 9 | 100.0% | 81.8% | 100.0% | 11 |
| 19 | Welche Briefe erwähnen Kritik an Jakob Andreae? | 54 | 100.0% | 79.4% | 100.0% | 68 |
| 20 | Welche Briefe erwähnen Berufung ins Bistum Samland? | 9 | 100.0% | 64.3% | 100.0% | 14 |
| 21 | Welche Briefe erwähnen Antitrinitarismus? | 22 | 100.0% | 88.0% | 100.0% | 25 |
| 22 | Welche Briefe erwähnen Kaiserliches Druckprivileg? | 8 | 100.0% | 72.7% | 100.0% | 11 |
| 23 | Welche Briefe erwähnen Entlassung eines Theologieprofessors? | 6 | 100.0% | 66.7% | 100.0% | 9 |
| 24 | Welche Briefe erwähnen Kirchengericht? | 8 | 100.0% | 88.9% | 100.0% | 9 |
| 25 | Welche Briefe erwähnen Seelenmesse? | 3 | 100.0% | 100.0% | 100.0% | 3 |
| 26 | Welche Briefe erwähnen Gasthof? | 6 | 100.0% | 66.7% | 100.0% | 9 |
| 27 | Welche Briefe erwähnen Griechisch-orthodoxes Patriarchat von Antiochien? | 3 | 100.0% | 50.0% | 100.0% | 6 |
| 28 | Welche Briefe erwähnen Chroniken? | 8 | 100.0% | 20.5% | 100.0% | 39 |
| 29 | Welche Briefe erwähnen Kost und Logis? | 5 | 100.0% | 100.0% | 100.0% | 5 |
| 30 | Welche Briefe erwähnen Herausgabe von Schriften? | 20 | 100.0% | 95.2% | 100.0% | 21 |
| 31 | Welche Briefe erwähnen Streit zwischen Zanchi und der Gemeinde in Chiavenna? | 3 | 100.0% | 60.0% | 100.0% | 5 |
| 32 | Welche Briefe erwähnen Feindseligkeit? | 6 | 100.0% | 24.0% | 100.0% | 25 |
| 33 | Welche Briefe erwähnen Röm 3? | 12 | 100.0% | 37.5% | 100.0% | 32 |

## 三、模板题·人物类（15 道）

随机抽样往来 ≥3 封的收发人对，金标 = 该方向全部公开信（含 [方括号] 推定变体）。

| # | 题目 | 金标数 | 召回 | 精确 | 引用召回 | 来源数 |
|---|---|---|---|---|---|---|
| 1 | Welche Briefe schrieb Johannes Brenz (d. Ä.) an Albrecht von Brandenburg-Ansbach, Herzog von Preußen? | 23 | 100.0% | 45.1% | 95.7% | 51 |
| 2 | Welche Briefe schrieb Matthäus Herbst an Johannes Parsimonius? | 3 | 100.0% | 23.1% | 100.0% | 13 |
| 3 | Welche Briefe schrieb Matthäus Vogel, Pfarrer und Superintendent zu Göppingen an Ludwig, Herzog von Württemberg? | 5 | 100.0% | 3.4% | 100.0% | 145 |
| 4 | Welche Briefe schrieb Johann Friedrich, Herzog von Württemberg an Württembergisches Konsistorium? | 5 | 100.0% | 55.6% | 100.0% | 9 |
| 5 | Welche Briefe schrieb Johannes Brenz (d. Ä.) an Philipp I. der Großmütige, Landgraf von Hessen? | 7 | 100.0% | 58.3% | 100.0% | 12 |
| 6 | Welche Briefe schrieb Paul Eber (d. Ä.) an Johannes Marbach? | 8 | 100.0% | 57.1% | 100.0% | 14 |
| 7 | Welche Briefe schrieb Philipp Marbach an Verordnete in Steiermark? | 12 | 100.0% | 52.2% | 100.0% | 23 |
| 8 | Welche Briefe schrieb Jakob Andreae an Hartmann Beyer? | 6 | 100.0% | 85.7% | 100.0% | 7 |
| 9 | Welche Briefe schrieb Lukas Osiander d. J. an Friedrich I., Herzog von Württemberg? | 5 | 100.0% | 50.0% | 100.0% | 10 |
| 10 | Welche Briefe schrieb Ludwig, Herzog von Württemberg an Jakob Heerbrand, Rektor? | 26 | 100.0% | 23.6% | 100.0% | 110 |
| 11 | Welche Briefe schrieb Johannes Kessel an Johann Jakob Grynaeus? | 17 | 100.0% | 58.6% | 100.0% | 29 |
| 12 | Welche Briefe schrieb Jakob Andreae an Johann der Ältere, Herzog von Schleswig-Holstein-Hadersleben? | 3 | 100.0% | 60.0% | 100.0% | 5 |
| 13 | Welche Briefe schrieb Petrus Patiens an Johannes Marbach? | 14 | 100.0% | 93.3% | 100.0% | 15 |
| 14 | Welche Briefe schrieb Philipp Marbach an Johannes Pappus? | 14 | 100.0% | 28.0% | 92.9% | 50 |
| 15 | Welche Briefe schrieb Pietro Paolo Vergerio an Albrecht von Brandenburg-Ansbach, Herzog von Preußen? | 12 | 100.0% | 85.7% | 100.0% | 14 |

## 四、内容型题（8 道）——金标来自 regest 正文，不来自标签

金标 = regest 正则命中的公开信；"未标签" = 其中没有匹配主题标签的部分，只有非标签路径（regest 全文 / embedding / 段落）能找到它们——这一列就是这些路径的真实成绩。

| # | 题目 | 金标 | 其中未标签 | 召回 | 未标签召回 | 精确 | 来源数 |
|---|---|---|---|---|---|---|---|
| 1 | Welche Briefe erwähnen einen Kometen? | 30 | 6 | 100.0% | 100.0% | 81.1% | 37 |
| 2 | Welche Briefe erwähnen eine Hungersnot? | 14 | 6 | 100.0% | 100.0% | 40.0% | 35 |
| 3 | Welche Briefe erwähnen Gicht? | 39 | 25 | 61.5% | 60.0% | 77.4% | 31 |
| 4 | Welche Briefe erwähnen Träume? | 38 | 34 | 21.1% | 14.7% | 57.1% | 14 |
| 5 | Welche Briefe erwähnen große Kälte? | 36 | 14 | 97.2% | 92.9% | 52.2% | 67 |
| 6 | Welche Briefe erwähnen eine Bibliothek? | 93 | 16 | 94.6% | 93.8% | 83.8% | 105 |
| 7 | Welche Briefe erwähnen Fieber? | 124 | 10 | 83.9% | 80.0% | 69.3% | 150 |
| 8 | Welche Briefe erwähnen Hexen oder Hexerei? | 19 | 3 | 78.9% | 0.0% | 75.0% | 20 |
