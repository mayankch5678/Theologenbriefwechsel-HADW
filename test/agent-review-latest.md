# ThBw RAG — Agent-Review

Erzeugt: 2026-09-11T12:05:49.315Z · 12 Fragen


---

## q2_ereignis

**Frage:** Welches Ereignis wird in den Briefen am häufigsten thematisiert?

**Lauf:** 1 Schritte, 3 s, 0 zitierte Briefe, Prüfungen bestanden

**Werkzeuge:**
- `count_by({"by":"subject","subject_group":"Ereignis","top":10})` → 22812 Briefe im Filter, 4374 mit Wert, 1198 Werte; Top: Konzil von Trient (300), 8. Hugenottenkrieg (1585-1598) (154), Wormser Religionsgespräch (1557) (110)

**Antwort:**

> Das mit Abstand häufigste Ereignis-Schlagwort ist **„Konzil von Trient"** mit **300 Briefen**. Es folgen:
> 
> | Ereignis | Briefe |
> |---|---|
> | Konzil von Trient | 300 |
> | 8. Hugenottenkrieg (1585–1598) | 154 |
> | Wormser Religionsgespräch (1557) | 110 |
> | Bedrohung Genfs durch den Herzog von Savoyen | 102 |
> | Schmalkaldischer Krieg (1546/47) | 97 |
> | Augsburger Reichstag (1530) | 85 |
> | Mömpelgarder Religionsgespräch (1586) | 75 |
> | Zerbster Konvent (1570) | 75 |
> | Reichstag | 66 |
> | Krieg zwischen Genf und Savoyen (1589/90) | 61 |
> 
> Grundlage: 22.812 Briefe im Archiv, davon 4.374 mit mindestens einem Ereignis-Schlagwort (1.198 verschiedene Ereignis-Schlagworte insgesamt).


---

## q3_bibelstelle_abendmahl

**Frage:** Welche Bibelstelle wird am Häufigsten im Zusammenhang mit dem Abendmahl erwähnt?

**Lauf:** 1 Schritte, 5 s, 0 zitierte Briefe, Prüfungen bestanden

**Werkzeuge:**
- `count_by({"by":"subject","subject_group":"Bibelstelle","filter":{"subject":"Abendmahl"}})` → 1350 Briefe im Filter, 429 mit Wert, 1364 Werte; Top: Neues Testament (29), Altes Testament (21), 1 Kor 10,16 (18)
- `list_values({"field":"subject","contains":"Abendmahl"})` → 76 Werte; Top: Abendmahl (723), Abendmahlsstreit (315), Gegenwart Christi im Abendmahl (114)

**Antwort:**

> Die häufigste Einzel-Bibelstelle in Briefen mit dem Schlagwort „Abendmahl" ist **1 Kor 10,16** (18 Briefe). Es folgen Eph 5,30 und Joh 6 (je 13 Briefe), Psalmen (12) und Mt 28,20 (11).
> 
> Zur Zählung: Der Filter „Abendmahl" erfasst 1350 Briefe, davon tragen 429 mindestens eine Bibelstellen-Angabe. Die häufigsten Gruppen sind die Sammelwerte „Neues Testament" (29) und „Altes Testament" (21), die keine einzelne Stelle bezeichnen; unter den konkreten Stellen liegt 1 Kor 10,16 vorn.
> 
> Die Zählung stammt aus `count_by`; dieses Werkzeug liefert nur Schlagwort-Werte mit Briefzahlen, keine einzelnen Briefnummern. Konkrete Briefe zu 1 Kor 10,16 habe ich nicht abgerufen, daher nenne ich hier keine Briefnummern.


---

## q4_frauen

**Frage:** Suche Briefe, die von Frauen geschrieben wurden

**Lauf:** 1 Schritte, 7 s, 49 zitierte Briefe, Prüfungen bestanden

**Werkzeuge:**
- `filter_letters({"sender_female":true,"limit":50})` → 136 Briefe (Seite ab 0)

**Antwort:**

> Insgesamt **136 Briefe** mit mindestens einer weiblichen Absenderin. Hier eine Auswahl (chronologisch, erste 50):
> 
> | Brief | Datum | Absenderin | Empfänger |
> |---|---|---|---|
> | Brief 11285 | 20. Nov. [1535/1564] | Maria Nachpur | Konrad Hubert |
> | Brief 11161 | [26. Mai 1538] | Margarethe Hubert (u. Ulrich Wieland) | Konrad Hubert |
> | Brief 14022 | 24. April 1544 | Katharina Zell (u. Kaspar Schwenckfeld) | Johannes Brenz d. Ä. |
> | Brief 40335 | 25. Mai 1549 | Katharina Zell | Martin Bucer; Paul Fagius |
> | Brief 55564 | 25. Juni [1550] | Wibrandis Rosenblatt | Martin Bucer |
> | Brief 90583 | 28. Aug. 1551 | Anna Flinner | Johannes Flinner |
> | Brief 16219 | 25. Mai 1554 | Coletta Vergerio | Pietro Paolo Vergerio |
> | Brief 39776 | 25. Juni 1554 | Sophia Isinder | Jakob Beurlin; Ruprecht Dürr |
> | Brief 16100 | 22. Juli 1554 | Maria Herbrot | Johannes Flinner |
> | Brief 16079 | 25. Juli 1554 | Coletta Vergerio | Pietro Paolo Vergerio |
> | Brief 63634 | [ca. 1555] | Olympia Fulvia Morata | Pietro Paolo Vergerio |
> | Brief 16279 | 27. Dez. 1555 | Katharina Zell | Ludwig Rabus |
> | Brief 16584 | 6. Feb. 1556 | Katharina Zell | Ludwig Rabus |
> | Brief 16744 | 9. Okt. 1556 | Anna Flinner | Konrad Hubert |
> | Brief 16996 | 24. März 1557 | Katharina Zell | Ludwig Rabus |
> | Brief 31040 | [nicht nach 19. Okt. 1558] | Barbara Gräter | Christoph, Hzg. v. Württemberg |
> | Brief 31836 | 19. April 1559 | Blandina Strigel | Johann Friedrich II. v. Sachsen |
> | Brief 30178 | 3. Nov. 1559 | Barbara Gräter | Christoph, Hzg. v. Württemberg |
> | Brief 17686 | 1. Feb. 1560 | Barbara, Gräfin v. Württemberg-Mömpelgard | Simon Sulzer; Bonifacius Amerbach |
> | Brief 31841 | 24. April 1560 | Blandina Strigel | Johann Friedrich II. v. Sachsen |
> | Brief 93411 | 18. Jan. 1561 | Blandina Strigel | Albrecht v. Brandenburg-Ansbach |
> | Brief 10338 | 5. Okt. 1561 | Elisabeth v. Braunschweig-Calenberg | Thomas Erastus |
> | Brief 50498 | 2. Nov. 1561 | Elisabeth v. Braunschweig-Calenberg | Thomas Erastus |
> | Brief 18174 | 12. April 1563 | Elisabeth v. Braunschweig-Calenberg | Thomas Erastus |
> | Brief 18973 | 28. Juli 1565 | Elisabeth v. Braunschweig-Calenberg | Thomas Erastus |
> | Brief 77633 | [ca. 1. Aug. 1567] | Margarete Schnepf | Dietrich Schnepf |
> | Brief 19707 | 16. Okt. 1569 | Hedwig, Hzgn. v. Braunschweig-Wolfenbüttel | Anna Andreae |
> | Brief 79106 | 7. Jan. 1570 | Anna Maria, Hzgn. v. Württemberg (u. Ludwig) | Parsimonius; Hipp |
> | Brief 40645 | 18. April 1570 | Dorothea, Königin v. Dänemark | Jakob Andreae |
> | Brief 89223 | 10. Juni [?] 1570 | Sophia Jagiellonica | Jakob Andreae |
> | Brief 19769 | 2. Aug. 1570 | Sophia Jagiellonica | Jakob Andreae |
> | Brief 19927 | [11.–20. Nov. 1570] | Katharina Brenz | Ludwig, Hzg. v. Württemberg |
> | Brief 19934 | 29. Nov. 1570 | Anna Maria, Hzgn. v. Württemberg | Heinrich IV. zu Castell |
> | Brief 33691 | 18. Dez. 1570 | Anna Maria, Hzgn. v. Württemberg | Johannes Parsimonius |
> | Brief 20106 | 24. Jan. 1571 | Hedwig, Hzgn. v. Braunschweig-Wolfenbüttel | Jakob Andreae |
> | Brief 20207 | 9. März 1571 | Anna Maria, Hzgn. v. Württemberg | Jakob Andreae |
> | Brief 84552 | 5. Juni 1571 | Sophia Jagiellonica | Jakob Andreae |
> | Brief 20252 | 7. Okt. 1571 | Sophia Jagiellonica | Jakob Andreae |
> | Brief 20462 | 5. Nov. 1572 | Dorothea, Pfalzgräfin bei Rhein | Johannes Brenz d. J. |
> | Brief 20508 | 6. April 1573 | Hedwig, Hzgn. v. Braunschweig-Wolfenbüttel | Jakob Andreae |
> | Brief 20641 | 3. Mai 1573 | Dorothea Susanna, Hzgn. v. Sachsen-Weimar | Wigand; Heshusius; Lipsius |
> | Brief 20631 | 14. Mai 1573 | Dorothea Susanna, Hzgn. v. Sachsen-Weimar | Heshusius; Wigand |
> | Brief 40974 | 24. Mai 1573 | Sophia Jagiellonica | Jakob Andreae |
> | Brief 20624 | 7. Juni 1573 | Dorothea Susanna, Hzgn. v. Sachsen-Weimar | Tilemann Heshusius |
> | Brief 46858 | [4. Sept. 1573 – 19. Sept. 1574] | Sophia Jagiellonica | Jakob Andreae |
> | Brief 20695 | Okt. 1573 | Margarethe Niger | Thomas Erastus; Univ. Heidelberg |
> | Brief 20667 | Nov. 1573 | Margarethe Niger | Thomas Erastus; Univ. Heidelberg |
> | Brief 89108 | 12. Juni 1574 | Anna, Kurfürstin v. Sachsen | Bartholomäus Hoffmann |
> | Brief 95558 | 1. Mai 1575 | Klara v. Sachsen-Lauenburg | Timotheus Kirchner (u. a.) |
> 
> Hinweis: Bei einigen Briefen (z. B. Brief 14022, Brief 11161, Brief 79106) ist neben der Frau auch ein männlicher Mitabsender genannt. Zwei Einträge (Brief 55564, Brief 89108) sind rein synthetische Metadaten-Einträge ohne Regest.
> 
> Für die vollständige Liste der 136 Briefe kann ich weitere Seiten abrufen.


---

## q5_regest_unvollstaendig

**Frage:** Suche Briefe, deren Regesten unvollständige Sätze enthalten

**Lauf:** 1 Schritte, 4 s, 14 zitierte Briefe, Prüfungen bestanden

**Werkzeuge:**
- `regest_issues({"art":"unvollstaendig","limit":50})` → 14 Briefe mit Befund (921/18092 Regesten geprüft)

**Antwort:**

> Die Regest-Qualitätsprüfung hat bislang 921 von 18.092 Regesten geprüft (Lauf noch nicht abgeschlossen). Sie meldet **14 Briefe** mit unvollständigen Sätzen:
> 
> | Brief | Stelle (beanstandet) | Hinweis |
> |---|---|---|
> | Brief 10058 | „Unterhaltung der Witwe und Erben eines verstorbenen Pfarrers mit den Pfründeneinkünften für zwei bis drei Jahren." | Satz ohne Verb |
> | Brief 11536 | „Gerüchte einer bevorstehenden Verlobung zwischen Margarete von Navarra und Karl V." | Satz ohne Prädikat |
> | Brief 11946 | „[5] Die folgenden Werke." | Satz ohne Verb, unvollständiger Gedanke |
> | Brief 12072 | „so bald er von einem sicheren Boten erfahre" / „Nachrichten über die Bedrohung Konstantinopels durch die Osmanen." | Satz bricht ab (Objekt fehlt) / Satz ohne Verb |
> | Brief 12123 | „er ein Generalkonzil einberufen will" | fehlendes Wort vor „er" |
> | Brief 12623 | „Der Abendmahlsgenuß der Ungläubigen." | Satz ohne Verb, bricht ab |
> | Brief 12693 | „über die hohe Zahl an von Zugereisten mit Empfehlungsschreiben" | Satz bricht ab, Bezugswort fehlt |
> | Brief 12749 | „Im Aufbruch begriffen, verpflichtet er B." | Satz bricht ab, Objekt fehlt |
> | Brief 13015 | „Die beiden möchten auch Calvins möglichst bald beantworten." | Objekt fehlt |
> | Brief 13216 | „Die Schrift Luthers gegen den Erzbischof von Mainz …" / „Die Ehe des Rechtsgelehrten Bitterlin." | Sätze ohne Prädikat |
> | Brief 13280 | „[Adelberg Meyer (kaum Altbürgermeister Jakob Meyer]" | Klammer nicht geschlossen |
> | Brief 13351 | „abgehalten worden ist An diesem Tanz" | Satzende ohne Punkt |
> | Brief 13356 | „Von Vergerios fleißiger theologischer Arbeit." | Satz ohne Prädikat |
> | Brief 40191 | „erwähnte Zuschrift Bucers mit einer ihr beigefügten Notiz" | Objekt zu „erwähnte" fehlt |
> 
> Hinweis der Prüfung: Regesten sind bewusst im Telegrammstil ohne Subjekt geschrieben; das gilt nicht als Mangel. Die Liste ist nicht abschließend, da erst ein Teil der Regesten geprüft wurde.


---

## q1_ausland

**Frage:** Welche Briefe behandeln Nachrichten aus dem Ausland (von Deutschland aus gesehen)?

**Lauf:** 1 Schritte, 6 s, 9 zitierte Briefe, Prüfungen: cites 9 < 10

**Werkzeuge:**
- `list_values({"field":"subject","contains":"Nachrichten","limit":50})` → 13 Werte; Top: Nachrichten (171), Nachrichten aus Frankreich (54), Falschnachrichten (22)
- `count_by({"by":"land_mentioned","filter":{"mentions_foreign":true},"top":30})` → 6890 Briefe im Filter, 6890 mit Wert, 20 Werte; Top: Eidgenossenschaft (4170), Reich (deutschsprachig) (3963), Frankreich (1281)
- `filter_letters({"mentions_foreign":true,"limit":50})` → 6890 Briefe (Seite ab 0)

**Antwort:**

> # Nachrichten aus dem Ausland (aus deutscher Sicht)
> 
> Zwei Wege führen zu unterschiedlichen Ergebnissen — beide Zahlen:
> 
> ## (a) Schlagworte „Nachrichten aus …" (Urteil der Editoren)
> 
> | Schlagwort | Briefe |
> |---|---|
> | Nachrichten aus Frankreich | 54 |
> | Nachrichten aus den Niederlanden | 17 |
> | Nachrichten aus England | 9 |
> | Nachrichten aus Italien | 6 |
> | Nachrichten aus Ungarn | 5 |
> | Nachrichten über die Türken | 3 |
> 
> Daneben die unspezifischen Schlagworte „Nachrichten" (171), „Falschnachrichten" (22), „Nachrichtenaustausch" (14), „Mangel an Nachrichten" (9), „Verbürgte Nachrichten" (8), „Bitte um Verbreitung von Nachrichten" (1), „Nachrichtennetzwerk" (1).
> 
> ## (b) Ortsklassifikation: Briefe mit mindestens einem auswärtigen Ort
> 
> **Gesamt: 6890 Briefe** (`mentions_foreign: true`). Verteilung nach Ländern (Mehrfachnennungen möglich):
> 
> | Land/Region | Briefe |
> |---|---|
> | Eidgenossenschaft | 4170 |
> | Reich (deutschsprachig) | 3963 |
> | Frankreich | 1281 |
> | Italien | 1224 |
> | Niederlande | 752 |
> | Osmanisches Reich | 659 |
> | England/Schottland | 595 |
> | Preußen (Herzogtum) | 384 |
> | Ungarn/Siebenbürgen | 371 |
> | Österreich/Habsburg. Erblande | 364 |
> | Polen/Litauen | 359 |
> | Böhmen/Mähren/Schlesien | 327 |
> | Spanien/Portugal | 225 |
> | Dänemark/Norwegen | 171 |
> | Nordafrika/Orient | 162 |
> | Russland | 58 |
> | Schweden | 49 |
> | Livland/Baltikum | 38 |
> | Amerika | 3 |
> 
> **Beispiele** (chronologisch, aus der ersten Seite der 6890 Treffer): Brief 11364 (Hedio an Myconius, Basel, 17. März 1520), Brief 11484 (Tossanus an Farel, Basel, 2. August 1524), Brief 10872 (Tossanus an Farel, Basel, 11. Februar [1525]), Brief 11570 (Tossanus an Farel, Basel, 4. September 1525), Brief 82871 (Straßburger Prediger an Luther, Straßburg, [ca. 8. Oktober 1525]), Brief 10875 (Tossanus an Oekolampad, Malesherbes, 26. Juli [1526]), Brief 10873 (Tossanus an Farel, Paris, 9. Dezember [1526]), Brief 11839 (Brenz an Isenmann, Augsburg, 21. Juni 1530), Brief 11948 (Brenz an Lachmann, Schwäbisch Hall, 4. Juni 1531).
> 
> ## Hinweis zur Diskrepanz
> 
> Die beiden Wege messen Verschiedenes: (a) zählt Briefe, deren **Thema** laut Editoren Auslandsnachrichten sind (max. 54 für ein einzelnes Land); (b) zählt Briefe, die **irgendeinen** auswärtigen Ort erwähnen — das schließt auch beiläufige Nennungen (z. B. Reiseorte, Druckorte, Herkunftsorte von Personen) ein und ist deshalb mit 6890 Briefen sehr viel weiter. Die Zahl 6890 ist daher **kein** Maß für „Briefe, die Auslandsnachrichten behandeln".


---

## q6_versoehnung

**Frage:** Welche Briefautoren sind mehr auf konfessionelle (religiöse) Versöhnung und Ausgleich bedacht als auf Abgrenzung?

**Lauf:** 3 Schritte, 21 s, 20 zitierte Briefe, Prüfungen bestanden

**Werkzeuge:**
- `search_letters({"query":"konfessionelle Versöhnung Ausgleich Einheit zwischen den Konfessionen","limit":30})` → 72 Treffer, Schlagworte: versöhnung, einheit, konfessionen
- `search_letters({"query":"Union Vergleich Ausgleich zwischen Lutheranern und Reformierten","limit":30})` → 24 Treffer, Schlagworte: vergleich
- `list_values({"field":"subject","contains":"inigkeit"})` → 12 Werte; Top: Einigkeit (139), Christliche Einigkeit (39), Uneinigkeit der Evangelischen (25)
- `list_values({"field":"subject","contains":"ersöhn"})` → 5 Werte; Top: Versöhnung (63), Versöhnung mit Gott (4), Allversöhnung (3)
- `list_values({"field":"subject","contains":"usgleich"})` → 0 Werte; Top: 
- `list_values({"field":"subject","contains":"onford"})` → 0 Werte; Top: 
- `count_by({"by":"sender","filter":{"subject":"Einigkeit"},"top":25})` → 404 Briefe im Filter, 404 mit Wert, 198 Werte; Top: Jakob Andreae (104), Philipp Melanchthon (17), Victorinus Strigel (15)
- `count_by({"by":"sender","filter":{"subject":"Versöhnung"},"top":25})` → 71 Briefe im Filter, 71 mit Wert, 60 Werte; Top: Jakob Andreae (9), Martin Bucer (6), Martin Frecht (6)
- `count_by({"by":"sender","filter":{"subject":"Christliche Einigkeit"},"top":25})` → 39 Briefe im Filter, 39 mit Wert, 24 Werte; Top: Jakob Andreae (23), Dorothea Susanna, Herzogin von Sachsen-Weimar (4), Johannes Marbach (2)
- `count_by({"by":"sender","filter":{"subject":"Vergleich"},"top":25})` → 78 Briefe im Filter, 78 mit Wert, 94 Werte; Top: Johannes Brenz (d. Ä.) (14), Jakob Andreae (5), Philipp Melanchthon (3)
- `count_by({"by":"sender","filter":{"subject":"Einigkeit im Glauben"},"top":25})` → 15 Briefe im Filter, 15 mit Wert, 14 Werte; Top: Jakob Andreae (6), Martin Frecht (2), Daniel Tossanus d. Ä. (1)
- `count_by({"by":"sender","filter":{"subject":"Einigkeit der evangelischen Kirchen"},"top":25})` → 8 Briefe im Filter, 8 mit Wert, 5 Werte; Top: Jakob Andreae (3), Wilhelm IV., Landgraf von Hessen-Kassel (2), Württembergische Theologen (2)
- `filter_letters({"subject":"Versöhnung","sender":"Pareus","limit":10})` → 3 Briefe (Seite ab 0)
- `filter_letters({"subject":"Einigkeit","sender":"Bucer","limit":10})` → 8 Briefe (Seite ab 0)
- `filter_letters({"subject":"Versöhnung","sender":"Bucer","limit":10})` → 6 Briefe (Seite ab 0)
- `read_letter({"id":"27132"})` → Brief 27132: 27132: 27. April 1614, Heidelberg. David Pareus an Axel Oxenstierna, schwedischer Kanzler
- `read_letter({"id":"40788"})` → Brief 40788: 40788: 7. Juni 1575, Kassel. Wilhelm IV., Landgraf von Hessen-Kassel an Jakob Andreae

**Antwort:**

> # Briefautoren mit Schwerpunkt auf konfessioneller Versöhnung und Ausgleich
> 
> Die Frage lässt sich nicht mit einem einzigen Kriterium beantworten, weil „Versöhnung/Ausgleich" im Archiv über mehrere Schlagworte läuft. Ich habe die einschlägigen Schlagworte gezählt (Grundlage: `count_by` über das gesamte Archiv) und die Profile der Spitzenreiter geprüft.
> 
> ## Wer am häufigsten Einigungs-/Versöhnungsthemen schreibt
> 
> **Jakob Andreae** ist der mit Abstand am stärksten auf Einigung ausgerichtete Autor:
> - 104 Briefe mit Schlagwort „Einigkeit" (nächstplatzierter: Philipp Melanchthon mit 17)
> - 23 Briefe mit „Christliche Einigkeit"
> - 9 Briefe mit „Versöhnung"
> - 6 Briefe mit „Einigkeit im Glauben", 3 mit „Einigkeit der evangelischen Kirchen"
> 
> Er ist der zentrale Autor des Konkordienwerks. Beispiele: Brief 31629 (Aussöhnung mit Martin Chemnitz, Konkordienverhandlungen), Brief 66596 und Brief 51967 (Torgauer Konvent 1576, Vergleich strittiger Glaubensartikel).
> 
> **Wilhelm IV., Landgraf von Hessen-Kassel** verbindet Einigungsbemühungen ausdrücklich mit Friedensliebe: 10 Briefe mit „Einigkeit", 2 mit „Versöhnung", 2 mit „Einigkeit der evangelischen Kirchen". In Brief 40788 beklagt er, dass die Theologen die Konflikte zu scharf führen, und nennt Melanchthon als Vorbild eines Theologen, der „stets das Gemeinsame und den Frieden suchte". In Brief 20926 werden ihm „Sanftmut" und „Friedensliebe" zugeschrieben.
> 
> **Martin Bucer** ist der profilierte frühe Ausgleichsautor: 7 Briefe mit „Einigkeit", 6 mit „Versöhnung", 8 mit „Vergleich". Beispiele: Brief 12833 (Hoffnung auf Einigung, Mäßigung Luthers), Brief 93980 (Wormser Religionsgespräch), Brief 61464 (Regensburger Reichstag 1541), Brief 36432 (Versöhnung im Abendmahlsstreit mit Calvin).
> 
> **David Pareus** ist der ausgeprägteste Ireniker am Ende des Zeitraums: 3 Briefe mit „Versöhnung". In Brief 27132 (an Oxenstierna) legt er sein „Irenicum" dar — die polemischen Schriften hätten die Wunden nur verschlimmert; er zeigt Einigungsmöglichkeiten auf und hofft auf einen Zusammenschluss der evangelischen Mächte. Vgl. auch Brief 25782 und Brief 26332 (Frieden, Kirche).
> 
> **Dorothea Susanna, Herzogin von Sachsen-Weimar**: 8 Briefe mit „Einigkeit", 4 mit „Christliche Einigkeit", 3 mit „Versöhnung" — u.a. Brief 22098 (Versöhnung mit Lukas Tangel, Verzicht auf Groll).
> 
> **Martin Frecht**: 10 Briefe mit „Einigkeit", 6 mit „Versöhnung", 2 mit „Einigkeit im Glauben" — wiederholt Klage über die Uneinigkeit der Evangelischen (Brief 14164, Brief 12382).
> 
> **Philipp Melanchthon**: 17 Briefe mit „Einigkeit", 3 mit „Versöhnung". In Brief 15602 betont er, nicht um Worte, sondern um die Sache zu streiten.
> 
> ## Einordnung und Grenzen
> 
> - Die Zahlen belegen, **wer Einigungs- und Versöhnungsthemen am häufigsten behandelt**. Sie belegen nicht durchgängig eine innere Haltung — bei Jakob Andreae etwa stehen Einigungsbemühungen (Konkordienwerk) neben scharfer Abgrenzung (z.B. Brief 39092 gegen „Irrlehre").
> - Eine Bewertung, wer „mehr auf Versöhnung als auf Abgrenzung bedacht" sei, verlangt eine Deutung über die Quellen hinaus. Belegbar ist nur, dass die genannten Autoren Versöhnung/Ausgleich explizit zum Thema machen; die Schlagworte sind das Urteil der Editoren über den Briefinhalt.
> - Nicht alle Treffer betreffen konfessionelle Einigung: Das Schlagwort „Vergleich" umfasst auch rein juristische/ökonomische Vergleiche (z.B. Brief 24679, Brief 63118, Brief 43116) und ist daher nur eingeschränkt aussagekräftig. Bei „Versöhnung" gibt es zudem die Varianten „Versöhnung mit Gott" (4 Briefe) und „Allversöhnung" (3 Briefe), die nicht zwischenmenschlich-konfessionell gemeint sind.


---

## a_heidelberg

**Frage:** Welche Briefe erwähnen den Heidelberger Katechismus?

**Lauf:** 4 Schritte, 12 s, 48 zitierte Briefe, Prüfungen bestanden

**Werkzeuge:**
- `list_values({"field":"subject","contains":"Katechismus"})` → 35 Werte; Top: Katechismus (100), Katechismusunterricht (60), Luthers Katechismus  (52)
- `search_letters({"query":"Heidelberger Katechismus","limit":40})` → 39 Treffer, Schlagworte: heidelberger katechismus frage 80, heidelberger katechismus lat übersetzung, bullinger beurteilung einer gegen den heidelberger katechismus gerichteten schmähschrift 1563 nicht erhalten
- `filter_letters({"subject":"Heidelberger Katechismus","limit":50})` → 48 Briefe (Seite ab 0)
- `filter_letters({"subject":"Heidelberger Katechismus","limit":50,"offset":40})` → 48 Briefe (Seite ab 40)
- `filter_letters({"subject":"Heidelberger Katechismus, Frage","limit":50})` → 5 Briefe (Seite ab 0)
- `filter_letters({"subject":"Verteidigung des Heidelberger Katechismus","limit":50})` → 1 Briefe (Seite ab 0)
- `filter_letters({"subject":"Apologie des Heidelberger Katechismus","limit":50})` → 3 Briefe (Seite ab 0)

**Antwort:**

> The filter returns 48 letters with the exact subject tag "Heidelberger Katechismus". Note that the search tool also surfaced letters with related tags (e.g. "Heidelberger Katechismus, Frage 80", "Verteidigung des Heidelberger Katechismus"). Let me check those related tags to give a complete picture.
> 
> Die Suche über das Schlagwort „Heidelberger Katechismus" (exakte Schreibweise der Editoren) ergibt **48 Briefe**. Hinzu kommen Briefe mit spezifischeren Schlagwort-Varianten, die denselben Gegenstand betreffen.
> 
> **Briefe mit dem Schlagwort „Heidelberger Katechismus" (48 insgesamt):**
> 
> 10368, 12211, 18494, 18495, 18529, 18549, 18556, 18570, 18598, 18615, 18674, 18678, 18695, 18699, 18711, 18735, 18769, 18855, 19050, 19248, 19287, 19561, 19939, 19988, 20866, 21237, 21368, 21415, 21680, 21862, 25851, 25903, 25951, 26057, 28159, 31293, 40240, 42954, 43044, 49362, 49669, 49791, 53666, 63439, 69764, 74873, 80071, 94644
> 
> **Zusätzliche Briefe mit spezifischeren Katechismus-Schlagworten (nicht in der Liste oben enthalten):**
> 
> - „Heidelberger Katechismus, Frage 80": Brief 63439 (bereits enthalten)
> - „Heidelberger Katechismus, Frage 1", „Frage 37", „Frage 60", „Heidelberger Katechismus, 1573 (VD16 ZV 24459)", „Heidelberger Katechismus lat. Übersetzung": je 1–2 Briefe (aus der Schlagwortliste; die genauen Briefnummern dieser Varianten habe ich nicht einzeln abgerufen)
> - „Bullinger, Apologie des Heidelberger Katechismus, 1563 (verloren)": 3 Briefe (u. a. Brief 18674)
> - „Bullinger, [Beurteilung einer gegen den Heidelberger Katechismus gerichteten Schmähschrift], 1563 (nicht erhalten)": 1 Brief (Brief 18695)
> - „Verteidigung des Heidelberger Katechismus": 1 Brief (Brief 18695)
> 
> **Hinweis zur Vollständigkeit:** Die 48 Briefe oben sind die verlässliche Gesamtzahl für das exakte Schlagwort „Heidelberger Katechismus". Die thematisch verwandten Varianten-Schlagworte (Frage-Nummern, Apologie, Verteidigung) überschneiden sich teils mit dieser Liste (z. B. Brief 63439, Brief 18695, Brief 18674); die genauen Briefnummern der reinen Frage-Varianten (Frage 1, 37, 60, 1573er Druck, lat. Übersetzung) habe ich nicht einzeln abgefragt.


---

## a_olevian_bullinger

**Frage:** Welche Briefe schrieb Kaspar Olevian an Heinrich Bullinger?

**Lauf:** 1 Schritte, 4 s, 3 zitierte Briefe, Prüfungen bestanden

**Werkzeuge:**
- `filter_letters({"sender":"Olevian","recipient":"Bullinger"})` → 3 Briefe (Seite ab 0)

**Antwort:**

> Kaspar Olevian schrieb **3 Briefe** an Heinrich Bullinger, alle aus Heidelberg:
> 
> - **Brief 18494** — 3. April 1563: Dank für eine Büchersendung; Übersendung je einer deutschen und lateinischen Ausgabe des Heidelberger Katechismus. Schlagworte: Büchersendung, Heidelberger Katechismus, 1. Hugenottenkrieg (1562/63), Frieden von Amboise (1563), Frieden, Jes 11,2.
> - **Brief 18678** — 25. Oktober 1563: Erklärung für seltene Briefe, Lob des Eifers des Erastus; Fertigstellung und Druck der kurpfälzischen Kirchenordnung. Schlagworte: Kurpfälzische Kirchenordnung (1563), Galaterbrief, Sakramente, Taufe, Abendmahl, Agende, Pest in Heidelberg (1563/64).
> - **Brief 18734** — 5. April 1564: Befürchtung drohender Auseinandersetzungen, Übersendung von Predigten, Angriff des Flacius auf Olevian und Bitte um Bullingers Einschätzung. Schlagworte: Innerprotestantische Streitigkeiten, Maulbronner Religionsgespräch (1564), Buchsendung, Predigten, mehrere Drucktitel.


---

## a_jahr_1563

**Frage:** Wie viele Briefe stammen aus dem Jahr 1563, und von wem stammen die meisten?

**Lauf:** 1 Schritte, 3 s, 1 zitierte Briefe, Prüfungen bestanden

**Werkzeuge:**
- `count_by({"by":"sender","filter":{"year_from":1563,"year_to":1563},"top":15})` → 391 Briefe im Filter, 391 mit Wert, 131 Werte; Top: Christoph, Herzog von Württemberg (72), Victorinus Strigel (59), Hieronymus Zanchi (32)
- `filter_letters({"year_from":1563,"year_to":1563,"limit":1})` → 391 Briefe (Seite ab 0)

**Antwort:**

> **391 Briefe** stammen aus dem Jahr 1563.
> 
> Die meisten stammen von **Christoph, Herzog von Württemberg** (72 Briefe), gefolgt von **Victorinus Strigel** (59) und **Hieronymus Zanchi** (32). Insgesamt verteilen sich die 391 Briefe auf 131 verschiedene Absender.
> 
> Die häufigsten Absender 1563:
> 
> | Absender | Briefe |
> |---|---|
> | Christoph, Herzog von Württemberg | 72 |
> | Victorinus Strigel | 59 |
> | Hieronymus Zanchi | 32 |
> | Pietro Paolo Vergerio | 29 |
> | Johannes Brenz (d. Ä.) | 14 |
> | Cunmann Flinspach | 9 |
> | Thomas Erastus | 9 |
> | Jakob Andreae | 8 |
> | Johannes Oporinus | 7 |
> | Timotheus Kirchner | 7 |
> 
> (Beispiel für einen Brief aus diesem Jahr: Brief 18563, Konrad Hubert an Johannes Sturm, 1. Januar 1563.)


---

## a_lookup_18494

**Frage:** Fasse den Brief 18494 zusammen.

**Lauf:** 1 Schritte, 4 s, 1 zitierte Briefe, Prüfungen bestanden

**Werkzeuge:**
- `read_letter({"id":"18494"})` → Brief 18494: 18494: 3. April 1563, [Heidelberg]. Kaspar Olevian an Heinrich Bullinger

**Antwort:**

> **Brief 18494** — Kaspar Olevian an Heinrich Bullinger, 3. April 1563, [Heidelberg] (Zielort Zürich).
> 
> Inhalt (Regest):
> - Olevian dankt für die Übersendung eines Buches und schickt Bullinger eine deutsche und eine lateinische Ausgabe des Heidelberger Katechismus; dessen Deutlichkeit sei auch den Schweizern zu verdanken.
> - Der Katechismus sei das Ergebnis des frommen Denkens vieler, nicht eines Einzelnen.
> - Bullinger hätte ihn früher erhalten sollen; Olevian wollte aber seinen Kollegen, besonders Erastus, das Lob nicht durch vorschnelle Freigebigkeit wegnehmen. Er sendet die Katechismen im Namen seiner Kollegen und bittet um Bullingers Urteil.
> - Der Kurfürst werde mit diesem Büchlein und eigenhändigen Briefen viele Könige und Fürsten belehren.
> - In Frankreich wurde Frieden geschlossen und dem Prinzen von Condé die Statthalterschaft des Königreichs anvertraut.
> 
> Schlagworte: Büchersendung; Heidelberger Katechismus; 1. Hugenottenkrieg (1562/63) [Ereignis]; Frieden von Amboise (1563) [Vertrag]; Frieden; Jes 11,2 [Bibelstelle].
> 
> Erwähnte Personen: Thomas Erastus, Friedrich III. der Fromme (Kurfürst von der Pfalz), Louis I. de Bourbon, Fürst von Condé. Erwähnter Ort: Frankreich.
> 
> Die Transkription des lateinischen Originals liegt vor (Incipit: „Gratias tibi ago venerande pater"); die editorische Erläuterung vermerkt, dass der Brief bei Sudhoff fälschlich auf den 14. April datiert ist.


---

## a_lookup_99999

**Frage:** Fasse den Brief 99999 zusammen.

**Lauf:** 1 Schritte, 3 s, 0 zitierte Briefe, Prüfungen bestanden

**Werkzeuge:**
- `read_letter({"id":"99999"})` → Fehler: Brief 99999 ist nicht im öffentlichen Archiv.

**Antwort:**

> Zu dieser Anfrage liegt kein Ergebnis vor: Die Suche nach der angegebenen Nummer hat keinen Brief im öffentlichen Archiv gefunden. Eine Zusammenfassung ist daher nicht möglich.


---

## a_offtopic

**Frage:** Was ist das beste Rezept für Pizza?

**Lauf:** 0 Schritte, 1 s, 0 zitierte Briefe, Prüfungen bestanden

**Werkzeuge:**


**Antwort:**

> Diese Frage betrifft nicht das Briefarchiv der Theologenbriefwechsel (1550–1620). Ich kann nur Fragen zu dessen Briefen beantworten — etwa zu Absendern, Empfängern, Orten, Schlagworten oder Inhalten der dort erfassten Korrespondenz. Ein Pizzarezept ist in diesem Bestand nicht enthalten.
