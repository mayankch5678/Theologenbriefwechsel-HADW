# ThBw RAG — Agent-Review

Erzeugt: 2026-09-13T19:14:39.556Z · 1 Fragen


---

## q6_versoehnung

**Frage:** Welche Briefautoren sind mehr auf konfessionelle (religiöse) Versöhnung und Ausgleich bedacht als auf Abgrenzung?

**Lauf:** 1 Schritte, 8 s, 20 zitierte Briefe, Prüfungen bestanden

**Werkzeuge:**
- `classify_letters({"criterion":"Zeigt der Absender in diesem Brief eine Haltung, die auf konfessionelle (religiöse) Versöhnung und Ausgleich zwischen den Konfessionen bedacht ist, oder überwiegt Abgrenzung/Polemik gegen Andersgläubige?","labels":[{"name":"versoehnung","description":"Der Absender wirbt für Einheit, Ausgleich, Verständigung, Mäßigung oder Kompromiss zwischen den Konfessionen; betont Gemeinsames, sucht Vermittlung."},{"name":"abgrenzung","description":"Der Absender grenzt sich scharf ab, polemisiert gegen Andersgläubige, verurteilt deren Lehre, fordert Trennung/Reinheit der eigenen Lehre."},{"name":"neutral","description":"Der Brief behandelt konfessionelle Fragen sachlich/informierend, ohne erkennbare versöhnliche oder abgrenzende Tendenz."}],"sort_by":"versoehnung","min_letters":10})` → fertig: 18092/22812 klassifiziert, 103 Gruppen; versoehnung 1821, abgrenzung 3797, nicht_bestimmbar 12474

**Antwort:**

> ## Ergebnis
> 
> Grundlage: Alle 22.812 Briefe des öffentlichen Archivs wurden geprüft; 4.720 haben kein Regest und sind nicht klassifizierbar, 18.092 wurden klassifiziert. Von diesen ließen sich 5.618 eindeutig einem der beiden Labels zuordnen (1.821 „versöhnung", 3.797 „abgrenzung"), 12.474 blieben unbestimmbar. Die Labels beruhen ausschließlich auf dem Wortlaut der editorischen Regesten, nicht auf Deutung.
> 
> **Autoren mit dem höchsten Versöhnungsanteil** (mind. 10 bestimmbare Briefe, sortiert nach Anteil):
> 
> | Autor | bestimmbar | versöhnung | abgrenzung | Anteil |
> |---|---|---|---|---|
> | Philipp I., Landgraf von Hessen | 12 | 11 | 1 | 92 % |
> | Wolfgang Capito | 22 | 19 | 3 | 86 % |
> | Albrecht von Brandenburg-Ansbach (Preußen) | 19 | 16 | 3 | 84 % |
> | Wilhelm IV., Landgraf von Hessen-Kassel | 30 | 25 | 5 | 83 % |
> | Julius, Herzog von Braunschweig-Wolfenbüttel | 22 | 18 | 4 | 82 % |
> | Wenzeslaus Zuleger | 10 | 7 | 3 | 70 % |
> | Valentin Helfant | 10 | 7 | 3 | 70 % |
> | Matthäus Vogel | 38 | 26 | 12 | 68 % |
> | Ludwig I., Graf von Sayn-Wittgenstein | 23 | 15 | 8 | 65 % |
> | Martin Bucer | 169 | 103 | 66 | 61 % |
> | Paul Eber d. Ä. | 17 | 10 | 7 | 59 % |
> | Philipp Melanchthon | 111 | 62 | 49 | 56 % |
> | Franciscus Junius d. Ä. | 25 | 14 | 11 | 56 % |
> | Simon Sulzer | 89 | 49 | 40 | 55 % |
> | Johannes Sturm | 11 | 6 | 5 | 55 % |
> | Kaspar Hedio | 37 | 20 | 17 | 54 % |
> 
> Belege (Auswahl):
> - Philipp I. von Hessen: Brief 11828 („bittet um Verständigung mit den Zwinglianern"), Brief 10099 („sieht mehr übereinstimmende als trennende Elemente … setzt auf den Dialog").
> - Capito: Brief 11915 („Vorschlag zu einer Einigung über die Abendmahlslehre"), Brief 12301 („sich gegenseitig schriftlich zum Frieden verpflichten").
> - Albrecht von Preußen: Brief 15552 („an der Beilegung des Streits mitzuwirken"), Brief 16020 („will aber über Osianders Lehre nicht weiter streiten").
> - Wilhelm IV. von Hessen-Kassel: Brief 80086 („Freude über die Unterstützung der Konkordienbemühungen"), Brief 80098 („sich weiter um die Konkordie bemühen").
> - Julius von Braunschweig-Wolfenbüttel: Brief 30198 („zur Beilegung der Streitigkeiten … und zur Erreichung der Einigkeit"), Brief 20621 („nach weiteren Wegen zur Konkordie suchen").
> - Bucer: Brief 12150 („Streit nicht durch eine Replik auf Luther verschärfen"), Brief 12022 („grundsätzliche Einheit zwischen den Kemptener Predigern").
> - Melanchthon: Brief 11779 („Vergleichsverhandlungen"), Brief 80729 („Notwendigkeit der Eintracht unter den [Evangelischen]").
> 
> **Viel schreibende Autoren mit umgekehrter Tendenz** (mehr Abgrenzung als Versöhnung, hohe Briefzahlen):
> - Johannes Brenz d. Ä.: 256 bestimmbar, 104 versöhnung / 152 abgrenzung (41 %), z. B. Brief 11560, Brief 11558.
> - Victorinus Strigel: 123 bestimmbar, 48 / 75 (39 %), z. B. Brief 16899.
> - Hieronymus Zanchi: 123 bestimmbar, 48 / 75 (39 %), z. B. Brief 16487.
> - Johannes Calvin: 39 bestimmbar, 15 / 24 (38 %), z. B. Brief 13079.
> - Cunmann Flinspach: 47 bestimmbar, 21 / 26 (45 %), z. B. Brief 14899.
> 
> Hinweis: Bei den meisten Autoren bleibt ein großer Teil der Briefe unbestimmbar (Briefe ohne konfessionell verwertbaren Regest-Wortlaut); die Anteile beziehen sich nur auf die bestimmbaren Briefe. Die Rangfolge ist der Anteil, nicht die absolute Zahl — Brenz und Strigel schreiben insgesamt weit mehr versöhnliche Briefe als etwa Philipp I. von Hessen, haben aber einen niedrigeren Anteil.
