// Exam training data for the German trainer (public/deutsch/).
// Modelled on the learner's own exam papers: the A1 term test (Hörverstehen 28,
// Leseverstehen 32, Schreiben 30 = 80 points) and the oral exam
// (Präsentation + Gespräch, 15 % of the final mark).
//
// Question types used below:
//   { q, o: [options], a: index, e? }        multiple choice / richtig-falsch
//   { q, fill: ['accepted', 'answers'], e? }  type the answer (lenient compare)
window.EXAM = {
  format: [
    { part: 'A Hörverstehen', en: 'Listening', points: 28, what: 'Fill in a form, match short dialogues, Manfred\'s week, phone messages, opening hours on announcements.', tip: 'Read the questions BEFORE you listen. Listen for names (spelled!), numbers, days and times.' },
    { part: 'B Leseverstehen', en: 'Reading', points: 32, what: 'Who does what? (4 people), postcards richtig/falsch, a city text, matching course ads, two notes, a letter → fill in the information.', tip: 'You don\'t need every word. Find the key words from the question in the text.' },
    { part: 'C Schreiben', en: 'Writing', points: 30, what: 'Complete a letter about a new flat (6 P.), plus two short texts (12 P. each): e-mails, invitations, replies.', tip: 'Answer EVERY point of the task. Short, correct sentences beat long, wrong ones. Greeting + text + closing.' },
    { part: 'Mündlich: Präsentation', en: 'Oral: presentation', points: null, what: 'A short monologue on your topic (5 minutes per person). You may use slides.', tip: 'Learn your text by heart, but speak, don\'t read. 8–12 simple sentences.' },
    { part: 'Mündlich: Gespräch', en: 'Oral: dialogue', points: null, what: 'A dialogue with a partner (in the 2nd semester after 20 minutes of preparation).', tip: 'Use ready phrases: Hast du am … Zeit? · Das passt gut. · Tut mir leid, da kann ich nicht. · Wie bitte?' },
  ],

  // ── Leseverstehen: the texts of the real term test + course-style texts ──
  reading: [
    {
      id: 'r1', title: 'Jugendliche und ihre Freizeit', lesson: 6, instr: 'Wer macht was? Read and choose the names.',
      text: [
        '<b>Lena, 14 Jahre:</b> Ich treffe mich am Nachmittag eigentlich fast immer mit Freundinnen. Im Sommer gehen wir Eis essen oder ins Freibad zum Schwimmen. Schwimmen ist toll! Im Winter gehen wir ins Café. Manchmal habe ich viele Hausaufgaben und keine Zeit für meine Freundinnen. Aber dann telefonieren wir am Abend noch.',
        '<b>Philipp, 16 Jahre:</b> Seit Herbst mache ich eine Ausbildung. Von Montag bis Freitag arbeite ich und habe nur wenig Freizeit. Am Abend bin ich zu müde für alles. Ich gehe auch nicht mehr ins Fitnessstudio. Nur am Wochenende mache ich noch Sport und treffe Freunde.',
        '<b>David, 18 Jahre:</b> Ich habe seit kurzem eine Freundin, Nina. Sie ist 17. Jetzt bin ich am Nachmittag und am Wochenende am liebsten mit ihr zusammen. Ich rufe sie jeden Abend noch an und sage ihr „Gute Nacht“. Oft reden wir dann noch Stunden. Für meine Freunde habe ich nicht mehr so viel Zeit.',
        '<b>Vanessa, 16 Jahre:</b> Ich mache gern Sport: Joggen, Tennis spielen, Schwimmen — ich mag einfach jeden Sport. Ich bin auch oft im Fitnessstudio, besonders im Winter. Mein Lieblingssport ist aber Schwimmen.',
      ],
      questions: [
        { q: 'a) ___ und ___ haben nur wenig Zeit für Freunde.', o: ['Lena und Vanessa', 'Philipp und David', 'David und Vanessa', 'Lena und Philipp'], a: 1, e: 'Philipp: „nur wenig Freizeit“; David: „Für meine Freunde habe ich nicht mehr so viel Zeit.“' },
        { q: 'b) ___ und ___ telefonieren viel.', o: ['Lena und David', 'Philipp und Vanessa', 'Lena und Vanessa', 'David und Philipp'], a: 0, e: 'Lena: „dann telefonieren wir am Abend“; David: „Ich rufe sie jeden Abend an … reden wir Stunden.“' },
        { q: 'c) ___ geht ins Fitnessstudio.', o: ['Philipp', 'Lena', 'Vanessa', 'David'], a: 2, e: 'Vanessa: „Ich bin auch oft im Fitnessstudio.“ Philipp geht NICHT MEHR.' },
        { q: 'd) ___ und ___ schwimmen gern.', o: ['Lena und Vanessa', 'Philipp und Lena', 'David und Vanessa', 'Philipp und David'], a: 0, e: 'Lena: „Schwimmen ist toll!“; Vanessa: „Mein Lieblingssport ist Schwimmen.“' },
      ],
    },
    {
      id: 'r2', title: 'Zwei Postkarten', lesson: 2, instr: 'Lesen Sie die Postkarten: richtig oder falsch?',
      text: [
        '<b>Hallo Anna,</b><br>wie geht es Dir? Mir geht es sehr gut. Ich bin gerade in Dresden. Hier wohnt meine Schwester. Dresden ist eine wunderschöne Stadt. Sie ist schon 800 Jahre alt. Dresden liegt im Osten von Deutschland. Warst Du schon mal in Ostdeutschland?<br>Bis bald wieder im Deutschkurs.<br>Natascha',
        '<b>Hallo Natascha,</b><br>danke für deine Karte. Mir geht’s auch gut. Ja, ich war schon mal in Ostdeutschland. Mein Mann kommt nämlich aus Leipzig. Das ist auch im Osten. Wann kommst Du zurück?<br>Viele Grüße,<br>Anna',
      ],
      questions: [
        { q: 'a) Natascha wohnt in Dresden.', o: ['richtig', 'falsch'], a: 1, e: 'Sie ist GERADE in Dresden (visiting). Ihre Schwester wohnt dort.' },
        { q: 'b) Sie hat eine Schwester.', o: ['richtig', 'falsch'], a: 0, e: '„Hier wohnt meine Schwester.“' },
        { q: 'c) Dresden ist in Ostdeutschland.', o: ['richtig', 'falsch'], a: 0, e: '„Dresden liegt im Osten von Deutschland.“' },
        { q: 'd) Anna ist verheiratet.', o: ['richtig', 'falsch'], a: 0, e: '„Mein Mann kommt aus Leipzig.“' },
        { q: 'e) Leipzig ist auch in Ostdeutschland.', o: ['richtig', 'falsch'], a: 0, e: '„Das ist auch im Osten.“' },
      ],
    },
    {
      id: 'r3', title: 'Willkommen in München!', lesson: 2, instr: 'Lesen Sie. Was ist richtig?',
      text: [
        'Kommen Sie nach Bayern, in das größte Bundesland Deutschlands! In der Landeshauptstadt München wohnen circa 1,3 Millionen Menschen. Hier sind Sie als Gast willkommen.',
        'Die Leute hier im Süden von Deutschland sind speziell. Sie sprechen auch speziell: „Mia san mia!“, sagen sie („Wir sind wir“), und „Grüß Gott“ („Guten Tag“).',
        'München, sagt man, ist „die nördlichste Stadt Italiens“. Von der Hauptstadt Bayerns ist es nämlich nicht weit nach Österreich und nach Italien. Aber warum so weit fahren? Auch in Bayern gibt es Berge und Seen: zum Beispiel die Zugspitze und den Watzmann, den Chiemsee und den Starnberger See …',
      ],
      questions: [
        { q: '1,3 Millionen Leute wohnen in …', o: ['München', 'Bayern'], a: 0, e: '„In der Landeshauptstadt München wohnen circa 1,3 Millionen Menschen.“' },
        { q: 'München liegt in …', o: ['Norddeutschland', 'Süddeutschland'], a: 1, e: '„hier im Süden von Deutschland“' },
        { q: 'Die Leute in München sagen …', o: ['Grüß Gott.', 'Guten Tag.'], a: 0, e: 'They say „Grüß Gott“ (it MEANS Guten Tag).' },
        { q: 'München ist die Hauptstadt von …', o: ['Deutschland', 'Bayern'], a: 1, e: '„Landeshauptstadt“, „Hauptstadt Bayerns“.' },
        { q: 'Der Chiemsee ist in …', o: ['Bayern', 'Italien'], a: 0, e: '„Auch in Bayern gibt es … den Chiemsee.“' },
      ],
    },
    {
      id: 'r4', title: 'Familie Chalkias sucht Deutschkurse', lesson: 5, instr: 'Welche Anzeige passt? Achtung: Eine Anzeige passt nicht.',
      text: [
        '<b>A</b> Machen Sie das Österreichische Sprachdiplom Deutsch (ÖSD)! Für ein Studium an österreichischen Universitäten müssen Sie exzellente Deutschkenntnisse nachweisen, zum Beispiel mit dem ÖSD. Wir sind anerkanntes Prüfungszentrum und bereiten Sie auf alle ÖSD-Prüfungen vor.',
        '<b>B</b> DEUTSCHKURS FÜR ANFÄNGER — Sprachschule in Athen. 1.2.–30.5., Mo–Mi 9–12 Uhr. Lehrbuch: Schritte international 1, ab Lektion 1. Gebühr: 480,– Euro.',
        '<b>C</b> Sprachurlaub in Deutschland, Österreich und der Schweiz — Machen Sie Urlaub und lernen Sie entspannt Deutsch! Einzel- und Gruppenunterricht ab 280 Euro.',
        '<b>D</b> Business-Deutschkurse! • Bürokommunikation • Technik • Tourismus — schon ab 4 Personen!',
        '<b>E</b> Zu Hause Deutsch lernen — klassisch mit Buch, mit Audio-CDs oder online, mit persönlichem Tutor, Abschlusstest. Wir stellen Ihr individuelles Lernprogramm zusammen!',
      ],
      questions: [
        { q: 'Vater Georgios arbeitet im Hotel. Er möchte spezielle Wörter lernen.', o: ['A', 'B', 'C', 'D', 'E'], a: 3, e: 'D: Business-Deutsch … Tourismus (hotel words).' },
        { q: 'Mutter Sofia kann nur Griechisch.', o: ['A', 'B', 'C', 'D', 'E'], a: 1, e: 'B: Deutschkurs für Anfänger in Athen.' },
        { q: 'Tochter Athina, 19, liebt Österreich. Sie möchte Medizin studieren.', o: ['A', 'B', 'C', 'D', 'E'], a: 0, e: 'A: ÖSD for studying at Austrian universities.' },
        { q: 'Sohn Ioannis, 15, lernt gern allein.', o: ['A', 'B', 'C', 'D', 'E'], a: 4, e: 'E: Zu Hause Deutsch lernen. (C passt nicht.)' },
      ],
    },
    {
      id: 'r5', title: 'Zwei Nachrichten im Büro', lesson: 5, instr: 'Lesen Sie die zwei Texte. Was ist richtig?',
      text: [
        '<b>Hallo Frau Peters,</b><br>können Sie bitte ein paar Dinge für mich machen? Ich habe leider keine Zeit! Meine Tochter hat heute Geburtstag. Bitte kaufen Sie Schokolade und ein Buch für sie. Herr Berger von IMMOTEC kommt am Mittwoch um 11 Uhr. Wir gehen zum Mittagessen. Bitte reservieren Sie einen Tisch im Restaurant Mykonos. Und rufen Sie Frau Breuer an. Am Freitag gehe ich mit meiner Frau ins Kino. Bitte kaufen Sie doch Kinokarten für den Film „Yella“. Danke!<br>Ralf Lehrmann',
        '<b>Hallo Herr Lehrmann,</b><br>natürlich mache ich alles. Aber Ihre Tochter hat nicht heute Geburtstag! Sie hat morgen, am Dienstag, Geburtstag. Und Herr Berger kommt nicht um 11 Uhr, er kommt schon um 10 Uhr. Reserviere ich trotzdem den Tisch? Frau Breuer ist erst heute Nachmittag zu Hause. Ich rufe sie dann an. Die Kinokarten kaufe ich auch am Nachmittag. Okay?<br>Viele Grüße<br>Christa Peters',
      ],
      questions: [
        { q: '1) Die Tochter von Ralf Lehrmann hat Geburtstag …', o: ['am Dienstag', 'heute'], a: 0, e: 'Frau Peters corrects him: „morgen, am Dienstag“.' },
        { q: '2) Herr Berger kommt …', o: ['um 10 Uhr', 'um 11 Uhr'], a: 0, e: '„er kommt schon um 10 Uhr“.' },
        { q: '3) Herr Berger kommt …', o: ['am Dienstag', 'am Mittwoch'], a: 1, e: '„am Mittwoch“ — only the time was wrong.' },
        { q: '4) Frau Breuer ist zu Hause …', o: ['am Vormittag', 'am Nachmittag'], a: 1, e: '„erst heute Nachmittag zu Hause“.' },
        { q: '5) Wer ruft Frau Breuer an?', o: ['Herr Lehrmann', 'Frau Peters'], a: 1, e: '„Ich rufe sie dann an“ — Frau Peters.' },
        { q: '6) Frau Peters kauft die Kinokarten …', o: ['am Nachmittag', 'am Freitag'], a: 0, e: '„Die Kinokarten kaufe ich auch am Nachmittag.“' },
      ],
    },
    {
      id: 'r6', title: 'Einladung: Schulparty', lesson: 5, instr: 'Lesen Sie und ergänzen Sie die Informationen.',
      text: [
        'Liebe Eltern der Klasse 4 b,<br>es ist wieder so weit: Am kommenden Samstag, den 5.6., ist Schulparty! Wir feiern wie immer in der Schule. Die Party fängt um 10 Uhr an und ist um 18 Uhr zu Ende. Ich möchte Sie dazu herzlich einladen.<br>Die Klassen machen ein buntes Programm. Ich möchte mit den Kindern Theater spielen und Kuchen verkaufen. Und wir brauchen Ihre Hilfe: Liebe Eltern, können Sie bitte Kuchen mitbringen?<br>Vielen Dank im Voraus.<br>Mit freundlichen Grüßen<br>Martina Hellwig, Klassenlehrerin der 4 b',
      ],
      questions: [
        { q: 'Wann? (day)', fill: ['Samstag', 'am Samstag', 'Samstag, 5.6.', 'Samstag, den 5.6.', '5.6.', 'am Samstag, den 5.6.'], e: 'Am Samstag, den 5.6.' },
        { q: 'von … (time)', fill: ['10 Uhr', '10', 'zehn Uhr', '10.00 Uhr'], e: 'von 10 Uhr …' },
        { q: '… bis (time)', fill: ['18 Uhr', '18', 'achtzehn Uhr', '18.00 Uhr'], e: '… bis 18 Uhr.' },
        { q: 'Wo?', fill: ['in der Schule', 'Schule', 'in der schule'], e: '„Wir feiern wie immer in der Schule.“' },
        { q: 'Programm von Klasse 4 b:', fill: ['Theater spielen und Kuchen verkaufen', 'Theater spielen, Kuchen verkaufen', 'Theater und Kuchen verkaufen', 'Theater spielen und Kuchen verkaufen.'], e: 'Theater spielen und Kuchen verkaufen.' },
        { q: 'Eltern sollen …', fill: ['Kuchen mitbringen', 'Kuchen bringen', 'einen Kuchen mitbringen'], e: 'Kuchen mitbringen.' },
      ],
    },
    {
      id: 'r7', title: 'Wohnungsanzeigen', lesson: 4, instr: 'Welche Anzeige passt?',
      text: [
        '<b>A</b> Schönes 1-Zi-Apartment, zentrale Lage, U-Bahn, 250 Euro + NK/KT. Tel. 0175/2102032',
        '<b>B</b> Urlaub in Bayern! Voll möblierte Ferienapartments, Kitchenette (super ausgestattet). 60 Euro/Nacht. Tel. 08856-9084',
        '<b>C</b> Zimmer in WG frei! Gleich anrufen: 0178 990066',
        '<b>D</b> Praktikantin sucht Möbel für 1-Zi-Wohnung. Tel 0160873456',
      ],
      questions: [
        { q: 'Sie möchten eine kleine Wohnung im Zentrum mieten.', o: ['A', 'B', 'C', 'D'], a: 0, e: 'A: 1-Zi-Apartment, zentrale Lage.' },
        { q: 'Sie möchten Ferien machen und brauchen ein Apartment für eine Woche.', o: ['A', 'B', 'C', 'D'], a: 1, e: 'B: Ferienapartments, 60 Euro pro Nacht.' },
        { q: 'Sie möchten ein Sofa verkaufen.', o: ['A', 'B', 'C', 'D'], a: 3, e: 'D: Praktikantin sucht Möbel.' },
        { q: 'Sie möchten mit anderen Studenten zusammen wohnen.', o: ['A', 'B', 'C', 'D'], a: 2, e: 'C: WG = Wohngemeinschaft (flat share).' },
        { q: '"NK" in Anzeige A bedeutet …', o: ['Nebenkosten', 'neue Küche', 'Nähe Kino', 'nicht kalt'], a: 0, e: 'NK = Nebenkosten, KT = Kaution.' },
      ],
    },
    {
      id: 'r8', title: 'Öffnungszeiten in Berlin', lesson: 5, instr: 'Lesen Sie und kreuzen Sie an.',
      text: [
        '<b>Berlin Tourist Info</b> — Kurfürstendamm 22. Mo–Sa 9.00–20.00, So 10.00–18.00',
        '<b>Café Einstein</b> — Kurfürstenstraße 58. Öffnungszeiten: täglich 8.00–1.00 Uhr',
        '<b>Kinder- und Jugendbibliothek</b> — Mo–Fr 15.00–19.00 Uhr, Sa 10.00–19.00 Uhr. An gesetzlichen Feiertagen geschlossen.',
        '<b>Brücke Museum</b> — Öffnungszeiten: täglich von 11 bis 17 Uhr, Dienstag geschlossen.',
      ],
      questions: [
        { q: 'Heute ist Sonntag, 9 Uhr. Die Tourist Info ist …', o: ['geöffnet', 'geschlossen'], a: 1, e: 'Sonntag erst ab 10.00.' },
        { q: 'Sie möchten um Mitternacht einen Kaffee trinken. Das geht im …', o: ['Café Einstein', 'Brücke Museum'], a: 0, e: 'Café Einstein: täglich bis 1.00 Uhr.' },
        { q: 'Die Bibliothek ist am Montag geöffnet …', o: ['von 10 bis 19 Uhr', 'von 15 bis 19 Uhr'], a: 1, e: 'Mo–Fr 15.00–19.00.' },
        { q: 'Am Dienstag kann man das Brücke Museum besuchen.', o: ['richtig', 'falsch'], a: 1, e: 'Dienstag geschlossen.' },
      ],
    },
  ],

  // ── Hörverstehen: scripts read aloud by the device's German voice ──
  // lines: [speaker ('A' | 'B'), text]; the app alternates two voices if available.
  listening: [
    {
      id: 'h1', title: 'Ein Formular ausfüllen', lesson: 1, instr: 'Hören Sie und ergänzen Sie das Formular.',
      lines: [
        ['A', 'Guten Tag. Wie heißen Sie, bitte?'], ['B', 'Mein Name ist Paula Ventura.'], ['A', 'Wie bitte? Buchstabieren Sie, bitte.'],
        ['B', 'V – E – N – T – U – R – A. Ventura.'], ['A', 'Danke. Und woher kommen Sie, Frau Ventura?'], ['B', 'Aus der Schweiz. Aus Biasca.'],
        ['A', 'Und wo wohnen Sie jetzt?'], ['B', 'In Hamburg. Marktstraße 12.'], ['A', 'Und wie ist Ihre Telefonnummer?'], ['B', 'Null vier null, sieben acht, acht sechs, drei neun.'],
      ],
      questions: [
        { q: 'Familienname', fill: ['Ventura'] },
        { q: 'Land', o: ['Österreich', 'Schweiz', 'Deutschland'], a: 1 },
        { q: 'Wohnort', fill: ['Hamburg'] },
        { q: 'Telefonnummer', o: ['040 78 86 39', '040 87 68 93', '040 78 68 39'], a: 0 },
      ],
    },
    {
      id: 'h2', title: 'Was macht Manfred?', lesson: 5, instr: 'Hören Sie den Dialog. Achtung: Heute ist Montag!',
      lines: [
        ['A', 'Hallo Manfred! Wollen wir diese Woche mal zusammen ins Kino gehen?'], ['B', 'Gern, aber ich habe viele Termine. Heute arbeite ich bis acht Uhr abends.'],
        ['A', 'Und morgen?'], ['B', 'Morgen, am Dienstag, spiele ich Fußball. Und am Mittwoch besuche ich meine Eltern.'],
        ['A', 'Hm. Und am Donnerstag?'], ['B', 'Am Donnerstag habe ich Deutschkurs, von sechs bis neun.'],
        ['A', 'Und am Freitag? Hast du am Freitag Zeit?'], ['B', 'Am Freitag? Ja, am Freitag habe ich Zeit. Da können wir ins Kino gehen!'],
      ],
      questions: [
        { q: 'Montag (heute): Manfred …', o: ['spielt Fußball', 'arbeitet bis 20 Uhr', 'besucht seine Eltern'], a: 1 },
        { q: 'Dienstag: Er …', o: ['spielt Fußball', 'hat Deutschkurs', 'geht ins Kino'], a: 0 },
        { q: 'Mittwoch: Er …', o: ['arbeitet', 'besucht seine Eltern', 'hat Zeit'], a: 1 },
        { q: 'Donnerstag: Er …', o: ['hat Deutschkurs', 'spielt Fußball', 'geht ins Kino'], a: 0 },
        { q: 'Freitag: Er …', o: ['arbeitet', 'geht ins Kino', 'besucht seine Eltern'], a: 1 },
      ],
    },
    {
      id: 'h3', title: 'Ninas Freunde rufen an', lesson: 6, instr: 'Nina hat Geburtstag und feiert am Samstag ab 19 Uhr. Hören Sie die Nachrichten: richtig oder falsch?',
      lines: [
        ['A', 'Hallo Nina, hier ist Jan. Danke für die Einladung! Ich komme gern zur Party. Ich bringe Wein mit. Den kaufe ich am Freitag. Bis Samstag!'],
        ['B', 'Hallo Nina, hier ist Marie. Tut mir leid, ich kann leider nicht kommen. Ich fahre am Samstag zu meinen Eltern. Feiert schön!'],
        ['A', 'Hi Nina, hier sind Eva und Jörg. Wir kommen sehr gern! Wir haben viele Stühle, die bringen wir mit. Und Eva macht einen Salat. Tschüs!'],
      ],
      questions: [
        { q: 'Jan kommt zur Party.', o: ['richtig', 'falsch'], a: 0 },
        { q: 'Er kauft am Samstag Wein.', o: ['richtig', 'falsch'], a: 1, e: 'Er kauft den Wein am FREITAG.' },
        { q: 'Marie fährt am Samstag zu den Eltern.', o: ['richtig', 'falsch'], a: 0 },
        { q: 'Marie kommt nicht.', o: ['richtig', 'falsch'], a: 0 },
        { q: 'Eva und Jörg bringen Stühle mit.', o: ['richtig', 'falsch'], a: 0 },
        { q: 'Jörg macht einen Salat.', o: ['richtig', 'falsch'], a: 1, e: 'EVA macht den Salat.' },
      ],
    },
    {
      id: 'h4', title: 'Ansagen: Öffnungszeiten', lesson: 5, instr: 'Was ist richtig? Hören Sie und kreuzen Sie an.',
      lines: [
        ['A', 'Herzlich willkommen im Hotel „Am Meer“. Unsere Rezeption ist von Montag bis Freitag von sieben bis zwölf Uhr und von fünfzehn bis einundzwanzig Uhr für Sie da. Am Wochenende von acht bis zwanzig Uhr.'],
        ['B', 'Sie sind mit dem Kundenservice von Sonnen-Jet verbunden. Leider rufen Sie außerhalb unserer Servicezeiten an. Wir sind montags bis freitags von acht bis zwanzig Uhr und samstags von zehn bis siebzehn Uhr für Sie da.'],
        ['A', 'Hier ist die Sprachschule Lingua. Wir sind von Montag bis Donnerstag am Vormittag und am Nachmittag erreichbar, am Freitag nur am Vormittag.'],
        ['B', 'Rechner-Doktor, Ihr Computerservice. Wir sind jeden Tag für Sie da, auch am Sonntag, von neun bis neunzehn Uhr.'],
      ],
      questions: [
        { q: 'Wann sind am Mittwoch die Rezeptionszeiten im Hotel „Am Meer“?', o: ['Von 7 bis 12 Uhr.', 'Von 7 bis 12 Uhr und von 15 bis 21 Uhr.', 'Von 8 bis 21 Uhr.'], a: 1 },
        { q: 'Wann ist der Kundenservice von „Sonnen-Jet“ am Samstag da?', o: ['Von 8 bis 20 Uhr.', 'Von 8 bis 17 Uhr.', 'Von 10 bis 17 Uhr.'], a: 2 },
        { q: 'Heute ist Freitag. Wann ist die Sprachschule erreichbar?', o: ['Am Vormittag.', 'Am Abend.', 'Am Vormittag oder am Nachmittag.'], a: 0 },
        { q: 'Wann ist der Rechner-Doktor geöffnet?', o: ['Am Sonntag.', 'Jeden Tag.', 'Von Montag bis Samstag.'], a: 1 },
      ],
    },
    {
      id: 'h5', title: 'Im Supermarkt', lesson: 3, instr: 'Hören Sie: Was kauft die Frau? Was kostet es?',
      lines: [
        ['A', 'Guten Tag. Was möchten Sie?'], ['B', 'Ich brauche ein Kilo Tomaten und sechs Eier, bitte.'], ['A', 'Ein Kilo Tomaten, sechs Eier. Sonst noch etwas?'],
        ['B', 'Haben Sie auch Milch?'], ['A', 'Nein, tut mir leid. Milch haben wir heute nicht.'], ['B', 'Schade. Was kosten hundert Gramm Käse?'],
        ['A', 'Zwei Euro fünfundvierzig.'], ['B', 'Gut, dann nehme ich hundert Gramm Käse.'], ['A', 'Das macht dann zusammen sieben Euro achtunddreißig.'],
      ],
      questions: [
        { q: 'Die Frau kauft …', o: ['Tomaten, Eier und Milch', 'Tomaten, Eier und Käse', 'Eier, Milch und Käse'], a: 1 },
        { q: 'Wie viele Eier?', o: ['sechs', 'zehn', 'sieben'], a: 0 },
        { q: '100 Gramm Käse kosten …', o: ['2,54 €', '2,45 €', '4,25 €'], a: 1 },
        { q: 'Zusammen:', o: ['7,38 €', '8,37 €', '7,83 €'], a: 0 },
      ],
    },
    {
      id: 'h6', title: 'Wetterbericht', lesson: 6, instr: 'Wie ist das Wetter? Hören Sie.',
      lines: [
        ['A', 'Und nun das Wetter für morgen. Im Norden ist es bewölkt und windig, bei acht Grad. Im Osten regnet es. Im Süden scheint die Sonne, es wird warm, bis achtzehn Grad. Im Westen gibt es viele Wolken, aber es bleibt trocken.'],
      ],
      questions: [
        { q: 'Im Norden ist es …', o: ['sonnig', 'bewölkt und windig', 'regnerisch'], a: 1 },
        { q: 'Im Osten …', o: ['schneit es', 'regnet es', 'scheint die Sonne'], a: 1 },
        { q: 'Im Süden sind es bis …', o: ['8 Grad', '18 Grad', '28 Grad'], a: 1 },
      ],
    },
    {
      id: 'h7', title: 'Einen Termin vereinbaren', lesson: 10, instr: 'Hören Sie das Telefongespräch.',
      lines: [
        ['A', 'Praxis Dr. Schmidt, guten Tag.'], ['B', 'Guten Tag, hier spricht Ezhkov. Ich habe Halsschmerzen und Fieber. Könnte ich bitte einen Termin haben?'],
        ['A', 'Heute ist leider alles voll. Geht es morgen um Viertel nach neun?'], ['B', 'Morgen Vormittag kann ich leider nicht. Haben Sie am Nachmittag einen Termin frei?'],
        ['A', 'Ja, um halb vier.'], ['B', 'Das passt gut. Vielen Dank!'], ['A', 'Bitte bringen Sie Ihre Versicherungskarte mit. Auf Wiederhören.'],
      ],
      questions: [
        { q: 'Was hat der Mann?', o: ['Kopfschmerzen', 'Halsschmerzen und Fieber', 'Bauchschmerzen'], a: 1 },
        { q: 'Der Termin ist morgen um …', o: ['9:15 Uhr', '15:30 Uhr', '14:30 Uhr'], a: 1, e: 'halb vier = 3:30 → 15:30.' },
        { q: 'Was soll er mitbringen?', o: ['seinen Ausweis', 'seine Versicherungskarte', 'Tabletten'], a: 1 },
      ],
    },
    {
      id: 'h8', title: 'An der Hotelrezeption', lesson: 9, instr: 'Hören Sie und kreuzen Sie an.',
      lines: [
        ['A', 'Guten Abend. Kann ich Ihnen helfen?'], ['B', 'Guten Abend. Ich habe ein Einzelzimmer reserviert. Mein Name ist Berger.'],
        ['A', 'Ah ja, Herr Berger. Für drei Nächte. Möchten Sie Halbpension oder Vollpension?'], ['B', 'Nur Frühstück, bitte. Von wann bis wann gibt es Frühstück?'],
        ['A', 'Von sieben bis zehn Uhr. Hier ist Ihr Schlüssel, Zimmer Nummer zweihundertvierunddreißig. Der Lift ist dort.'], ['B', 'Danke. Und wann muss ich auschecken?'], ['A', 'Um elf Uhr.'],
      ],
      questions: [
        { q: 'Herr Berger hat … reserviert.', o: ['ein Doppelzimmer', 'ein Einzelzimmer', 'zwei Zimmer'], a: 1 },
        { q: 'Er bleibt …', o: ['zwei Nächte', 'drei Nächte', 'eine Woche'], a: 1 },
        { q: 'Frühstück gibt es …', o: ['von 7 bis 10 Uhr', 'von 8 bis 10 Uhr', 'von 7 bis 11 Uhr'], a: 0 },
        { q: 'Zimmernummer:', o: ['243', '234', '324'], a: 1 },
      ],
    },
  ],

  // ── Schreiben ──
  writing: [
    {
      id: 'w1', title: 'Eine neue Wohnung (Test task 1)', lesson: 4, points: 6,
      task: 'Complete the letter to a friend. Write about your new flat: how many rooms, how big, which rooms, what you like.',
      start: 'Liebe …,\nwir haben jetzt auch eine ideale Wohnung gefunden. …\nDie Küche ist leider nur klein. …\nUnd ihr? …\nViele Grüße von …',
      points_list: ['How many rooms / how big (m²)', 'Which rooms (Wohnzimmer, Schlafzimmer, Bad, Balkon …)', 'Describe: hell, groß, schön, (nicht) teuer', 'Ask about their flat: Und ihr?'],
      model: 'Liebe Anna,\nwir haben jetzt auch eine ideale Wohnung gefunden. Sie hat drei Zimmer und ist 70 Quadratmeter groß. Das Wohnzimmer ist sehr groß und hell. Wir haben auch einen Balkon. Die Miete ist nicht teuer: Sie kostet 800 Euro warm. Die Küche ist leider nur klein. Aber das Bad ist neu und schön. Das Schlafzimmer gefällt mir sehr gut.\nUnd ihr? Wie ist eure Wohnung? Wie viele Zimmer hat sie?\nViele Grüße von Oleg',
    },
    {
      id: 'w2', title: 'Antwort auf eine Einladung', lesson: 6, points: 12,
      task: 'Your friend Nina writes: „Liebe Leute, ich habe Geburtstag und feiere am Samstag ab 19 Uhr. Kommt ihr? Wer bringt etwas zu essen oder Getränke mit? Wir brauchen auch noch Stühle.“ Answer: say thank you, say you are coming, what you bring, ask a question.',
      start: 'Liebe Nina,\n…\nViele Grüße\n…',
      points_list: ['Danke für die Einladung', 'Ich komme gern …', 'What you bring (Salat, Kuchen, Getränke, Stühle)', 'A question (Wo? Wer kommt noch? …)'],
      model: 'Liebe Nina,\nvielen Dank für die Einladung! Ich komme sehr gern zu deiner Party. Ich bringe einen Kuchen und zwei Flaschen Saft mit. Ich habe auch zwei Stühle, die bringe ich auch mit. Wer kommt noch? Und wo ist die Party, bei dir zu Hause?\nBis Samstag!\nViele Grüße\nOleg',
    },
    {
      id: 'w3', title: 'Absage und neuer Termin', lesson: 5, points: 12,
      task: 'A friend asks you: „Hast du am Freitag Zeit? Wir gehen ins Kino.“ You cannot come. Say sorry, say why, suggest another day and time.',
      start: 'Hallo …,\n…\nLiebe Grüße\n…',
      points_list: ['Tut mir leid / leider …', 'Why (ich muss arbeiten, ich habe Deutschkurs …)', 'A new day + time (Hast du am … um … Zeit?)', 'Greeting + closing'],
      model: 'Hallo Max,\nvielen Dank für deine Nachricht. Tut mir leid, aber am Freitag habe ich leider keine Zeit. Ich muss lange arbeiten und am Abend habe ich Deutschkurs. Hast du am Samstag Zeit? Wir können um 18 Uhr ins Kino gehen und danach essen. Was meinst du?\nLiebe Grüße\nOleg',
    },
    {
      id: 'w4', title: 'Mein Tag', lesson: 5, points: 12,
      task: 'Write about your normal day: when you get up, work/study, eat, free time, go to bed. Use separable verbs and time words.',
      start: 'Ich stehe um … auf. …',
      points_list: ['aufstehen + time', 'frühstücken / zur Arbeit / zur Uni gehen', 'am Nachmittag / am Abend …', 'ins Bett gehen + time', 'Use am / um / von … bis'],
      model: 'Ich stehe jeden Tag um sieben Uhr auf. Zuerst trinke ich Kaffee und frühstücke. Um halb neun fahre ich zur Universität. Von neun bis drei habe ich Unterricht. Am Nachmittag kaufe ich im Supermarkt ein. Am Abend koche ich und sehe ein bisschen fern. Manchmal rufe ich meine Eltern an. Um elf Uhr gehe ich ins Bett.',
    },
    {
      id: 'w5', title: 'Mein Wochenende (Perfekt)', lesson: 7, points: 12,
      task: 'Write what you did last weekend. Use the Perfekt with haben and sein.',
      start: 'Am Samstag habe ich …',
      points_list: ['Saturday morning / afternoon / evening', 'Sunday', 'haben + participle (gemacht, gegessen …)', 'sein + participle (gegangen, gefahren …)', 'How was it? (Es war super / Das hat Spaß gemacht)'],
      model: 'Am Samstag habe ich lange geschlafen. Dann habe ich gefrühstückt und die Wohnung aufgeräumt. Am Nachmittag habe ich Freunde getroffen. Wir sind in den Park gegangen und haben Fußball gespielt. Am Abend sind wir ins Kino gegangen. Der Film war super! Am Sonntag bin ich zu meinen Eltern gefahren. Wir haben zusammen gegessen. Das Wochenende hat viel Spaß gemacht.',
    },
    {
      id: 'w6', title: 'Eine Anfrage schreiben', lesson: 10, points: 12,
      task: 'You saw an ad for a sports group ("Lauftreff", Tuesday and Thursday 18:00, free). Write a formal enquiry: you are interested, ask two questions (how many kilometres? only once a week possible?).',
      start: 'Sehr geehrte Damen und Herren,\n…\nMit freundlichen Grüßen\n…',
      points_list: ['Formal greeting', 'Ich habe Ihre Anzeige gelesen …', 'Two questions (Kann man …? Wie viele …?)', 'Vielen Dank für Ihre Auskunft.', 'Mit freundlichen Grüßen + name'],
      model: 'Sehr geehrte Damen und Herren,\nich habe Ihre Anzeige gelesen und finde Ihr Angebot sehr interessant. Ich möchte gern mit einer Gruppe Sport machen, aber ich habe nicht viel Zeit und bin nicht sehr sportlich. Ich habe folgende Fragen: Wie viele Kilometer laufen Sie? Kann man auch nur einmal pro Woche kommen?\nVielen Dank für Ihre Auskunft.\nMit freundlichen Grüßen\nOleg Ezhkov',
    },
    {
      id: 'w7', title: 'Ein Hotelzimmer buchen', lesson: 9, points: 12,
      task: 'Write an e-mail to a hotel. You want a single room from 7 to 9 March. Ask: is breakfast included? Is there free Wi-Fi? Can you park there?',
      start: 'Sehr geehrte Damen und Herren,\n…',
      points_list: ['Formal greeting', 'Einzelzimmer vom … bis …', '2–3 questions', 'Polite closing'],
      model: 'Sehr geehrte Damen und Herren,\nich möchte gern vom 7. bis 9. März ein Einzelzimmer reservieren. Ich habe noch Fragen: Ist das Frühstück inklusive? Gibt es kostenloses WLAN im Zimmer? Kann man beim Hotel parken?\nVielen Dank für Ihre Antwort.\nMit freundlichen Grüßen\nOleg Ezhkov',
    },
  ],

  // ── Mündlich: Präsentation (topics of the course, both semesters) ──
  presentations: [
    { id: 'p1', sem: 1, lesson: 1, topic: 'Wer sind Sie? Erzählen Sie über sich selbst!', en: 'Who are you? Talk about yourself (name, age, place of birth, where you live …)',
      model: ['Guten Tag! Ich heiße Oleg Ezhkov.', 'Ich bin 20 Jahre alt.', 'Ich bin in Sankt Petersburg geboren.', 'Ich wohne jetzt auch in Sankt Petersburg.', 'Ich bin Student. Ich studiere Management.', 'Ich spreche Russisch, Englisch und ein bisschen Deutsch.', 'Ich bin ledig.', 'Meine Hobbys sind Snowboard fahren und Sport.', 'Ich lerne Deutsch, denn Deutsch ist wichtig für meine Arbeit.', 'Danke für Ihre Aufmerksamkeit!'] },
    { id: 'p2', sem: 1, lesson: 2, topic: 'Erzählen Sie über Ihren Freund / Ihre Freundin!', en: 'Talk about your friend (name, age, place of birth, where he/she lives …)',
      model: ['Das ist mein Freund Vlad.', 'Er ist 21 Jahre alt.', 'Er kommt aus Russland, aus Nowosibirsk.', 'Jetzt lebt er in Sankt Petersburg.', 'Er studiert Informatik.', 'Er spricht Russisch und sehr gut Englisch.', 'Er ist nicht verheiratet.', 'Sein Hobby ist Fußball. Er spielt jeden Samstag.', 'Wir treffen uns oft am Wochenende.', 'Er ist sehr nett!'] },
    { id: 'p3', sem: 1, lesson: 2, mine: true, topic: 'Erzählen Sie über Ihre Familie!', en: 'YOUR 1st-semester topic: talk about your family (names, age, place of birth, where they live …)',
      model: ['Ich möchte meine Familie vorstellen.', 'Meine Familie ist nicht sehr groß.', 'Das ist mein Vater. Er heißt Andrej und ist 50 Jahre alt.', 'Er ist Ingenieur von Beruf.', 'Das ist meine Mutter. Sie heißt Elena. Sie ist 48.', 'Sie arbeitet als Lehrerin.', 'Meine Eltern sind verheiratet und leben in Sankt Petersburg.', 'Ich habe eine Schwester. Sie heißt Anna und ist 16 Jahre alt. Sie geht noch zur Schule.', 'Meine Großeltern wohnen in Moskau. Meine Oma kocht sehr gut!', 'Wir haben auch einen Hund. Er heißt Max.', 'Ich liebe meine Familie. Danke!'],
      tip: 'Replace the names, ages and jobs with your REAL family — the examiner may ask: Wie heißt dein Vater? Was ist deine Mutter von Beruf? Wo wohnen deine Großeltern?' },
    { id: 'p4', sem: 1, lesson: 3, topic: 'Was essen und trinken Sie gern / nicht gern? Wo essen Sie oft?', en: 'What do you like / not like to eat and drink? Where do you often eat?',
      model: ['Ich esse sehr gern Fleisch, zum Beispiel Hähnchen mit Pommes.', 'Mein Lieblingsessen ist Pizza.', 'Ich esse nicht so gern Fisch.', 'Ich trinke gern Kaffee und Saft.', 'Cola trinke ich nicht gern.', 'Zum Frühstück esse ich Brot mit Käse.', 'Am Mittag esse ich in der Mensa.', 'Am Abend koche ich zu Hause.', 'Am Wochenende esse ich manchmal im Restaurant mit Freunden.', 'Das schmeckt sehr gut!'] },
    { id: 'p5', sem: 1, lesson: 3, topic: 'Kochen Sie gern? Was kochen Sie gut? Was brauchen Sie dafür?', en: 'Do you like cooking? What do you cook well? What do you need?',
      model: ['Ja, ich koche sehr gern.', 'Ich koche gut Pfannkuchen.', 'Für Pfannkuchen brauche ich Mehl, Milch, Eier, Zucker und ein bisschen Salz.', 'Ich brauche 250 Gramm Mehl, einen halben Liter Milch und drei Eier.', 'Dazu esse ich gern Bananen oder Schokolade.', 'Ich kaufe alles im Supermarkt.', 'Das ist nicht teuer.', 'Meine Freunde essen meine Pfannkuchen sehr gern.', 'Das schmeckt super lecker!'] },
    { id: 'p6', sem: 1, lesson: 4, topic: 'Wie sieht Ihr Zimmer aus? Gefällt Ihnen das Zimmer? Warum (nicht)?', en: 'What does your room look like? Do you like it? Why (not)?',
      model: ['Mein Zimmer ist nicht sehr groß, aber es ist hell.', 'Es hat ein großes Fenster.', 'Im Zimmer sind ein Bett, ein Schreibtisch, ein Stuhl und ein Schrank.', 'Mein Schreibtisch ist braun und ziemlich alt.', 'Auf dem Schreibtisch sind mein Computer und meine Bücher.', 'Ich habe auch ein Regal und eine Lampe.', 'Der Teppich ist grau.', 'Das Zimmer gefällt mir gut, denn es ist hell und ruhig.', 'Aber der Schrank ist sehr klein.'] },
    { id: 'p7', sem: 1, lesson: 4, topic: 'Wie sieht Ihre Traumwohnung / Ihr Traumhaus aus? Wer wohnt da?', en: 'Your dream flat / house — what does it look like? Who lives there?',
      model: ['Meine Traumwohnung ist groß und hell.', 'Sie hat vier Zimmer: ein Wohnzimmer, ein Schlafzimmer, ein Arbeitszimmer und ein Gästezimmer.', 'Die Küche ist modern und groß.', 'Das Bad hat eine Badewanne und eine Dusche.', 'Die Wohnung hat einen Balkon. Dort trinke ich Kaffee.', 'Sie liegt im Zentrum von Sankt Petersburg.', 'Die Möbel sind weiß und modern.', 'Ich wohne dort mit meiner Familie.', 'Die Wohnung ist sehr teuer, aber sie ist mein Traum!'] },
    { id: 'p8', sem: 1, lesson: 5, topic: 'Ein Tag aus Ihrem Leben.', en: 'A day in your life (when you get up, where you go, what you do …)',
      model: ['Ich stehe um sieben Uhr auf.', 'Zuerst trinke ich Kaffee und frühstücke.', 'Um halb neun fahre ich zur Uni.', 'Von neun bis drei habe ich Unterricht.', 'Um eins esse ich in der Mensa.', 'Am Nachmittag gehe ich ins Fitnessstudio.', 'Dann kaufe ich im Supermarkt ein.', 'Am Abend koche ich und lerne Deutsch.', 'Um elf Uhr sehe ich ein bisschen fern.', 'Um Mitternacht gehe ich ins Bett.'] },
    { id: 'p9', sem: 1, lesson: 5, topic: 'Eine Woche aus Ihrem Leben.', en: 'A week in your life — what do you do when? Do you like it?',
      model: ['Von Montag bis Freitag habe ich Unterricht an der Uni.', 'Am Montag und am Mittwoch habe ich Deutschkurs.', 'Am Dienstag spiele ich Fußball. Das mache ich sehr gern.', 'Am Donnerstag arbeite ich von vier bis acht Uhr.', 'Am Freitagabend treffe ich Freunde.', 'Am Samstag räume ich die Wohnung auf und kaufe ein.', 'Das mache ich nicht so gern.', 'Am Sonntag schlafe ich lange.', 'Am Abend rufe ich meine Eltern an.'] },
    { id: 'p10', sem: 1, lesson: 5, topic: 'Wie verbringe ich das Wochenende?', en: 'How do I spend the weekend?',
      model: ['Am Wochenende habe ich viel Zeit.', 'Am Samstag stehe ich spät auf, um zehn Uhr.', 'Am Morgen frühstücke ich lange.', 'Am Nachmittag mache ich Sport oder gehe spazieren.', 'Am Abend treffe ich Freunde. Wir gehen ins Kino oder essen im Restaurant.', 'Am Sonntag räume ich auf.', 'Am Nachmittag besuche ich meine Familie.', 'Am Abend lerne ich ein bisschen Deutsch.', 'Das Wochenende ist super!'] },
    { id: 'p11', sem: 2, lesson: 6, topic: 'Meine Freizeit. Was mache ich im Sommer / Winter / Herbst / Frühling besonders gern?', en: 'My free time — what do I like doing in each season?',
      model: ['In meiner Freizeit mache ich gern Sport.', 'Im Winter fahre ich Snowboard. Das macht viel Spaß!', 'Ich fahre auch gern Ski.', 'Im Frühling gehe ich gern im Park spazieren.', 'Im Sommer schwimme ich und spiele Fußball mit Freunden.', 'In Sankt Petersburg gibt es im Sommer die Weißen Nächte. Das finde ich toll.', 'Im Herbst regnet es oft. Dann gehe ich ins Kino oder lese.', 'Mein Lieblingssport ist Snowboard.', 'Danke fürs Zuhören!'] },
    { id: 'p12', sem: 2, lesson: 6, topic: 'Was brauche ich für meine Hobbys? Was muss man haben / kaufen?', en: 'What do I need for my hobbies? (use the accusative!)',
      model: ['Mein Hobby ist Snowboard fahren.', 'Dafür brauche ich ein Snowboard.', 'Ich brauche auch einen Helm und eine Brille.', 'Man braucht eine warme Jacke und eine Hose.', 'Ich habe auch einen Rucksack.', 'Mein Snowboard war sehr teuer.', 'Ich spiele auch Gitarre. Dafür brauche ich nur eine Gitarre und viel Zeit!', 'Ich sammle keine Briefmarken.'], tip: 'Accusative! einen Helm, einen Rucksack (der → einen); eine Jacke; ein Snowboard.' },
    { id: 'p13', sem: 2, lesson: 7, topic: 'Meine Hobbys. Was kann ich machen? Was will ich lernen?', en: 'My hobbies — what can I do? What do I want to learn?',
      model: ['Ich kann gut Snowboard fahren.', 'Ich kann auch gut schwimmen.', 'Ich kann ein bisschen Gitarre spielen.', 'Ich kann nicht gut singen.', 'Ich kann gar nicht tanzen.', 'Ich will gut Deutsch lernen.', 'Ich will auch Tennis spielen lernen.', 'Nächstes Jahr will ich nach Deutschland fahren.'] },
    { id: 'p14', sem: 2, lesson: 7, mine: true, topic: 'Erzählen Sie, wo haben Sie etwas gelernt?', en: 'YOUR 2nd-semester topic: where did you learn something? (from your own slides: snowboard, English, driving)',
      model: ['Ich möchte erzählen: Wo habe ich etwas gelernt?', 'Zuerst: Snowboard.', 'Ich habe Snowboard im Snowpark gelernt.', 'Der Kurs war sehr gut. Der Lehrer war nett und geduldig.', 'Ich habe viel geübt. Snowboard macht mir viel Spaß!', 'Dann: Englisch.', 'Ich habe Englisch im Sprachkurs gelernt.', 'Die Schule war in der Stadtmitte. Der Unterricht war sehr interessant und die Lehrerin war nett.', 'Der Kurs hat mir viel Spaß gemacht!', 'Und zum Schluss: Auto fahren.', 'Ich habe in der Fahrschule fahren gelernt.', 'Der Fahrlehrer war streng, aber fair. Ich habe viel geübt. Es war nicht einfach.', 'Aber ich habe die Prüfung bestanden!', 'Danke für Ihre Aufmerksamkeit!'],
      tip: 'Perfekt: haben + gelernt / geübt / bestanden; war = was. The examiner may ask: Wann hast du das gelernt? Wie lange hat der Kurs gedauert? Kannst du jetzt gut Englisch sprechen?' },
    { id: 'p15', sem: 2, lesson: 8, topic: 'Mein Traumberuf. Was will ich werden? Warum?', en: 'My dream job — what do I want to become? Why? Where do I study and work?',
      model: ['Mein Traumberuf ist Manager.', 'Ich studiere seit einem Jahr Management an der Universität in Sankt Petersburg.', 'Vor zwei Jahren habe ich mein Abitur gemacht.', 'Ich will in einer großen internationalen Firma arbeiten.', 'Der Beruf ist interessant, denn man arbeitet mit vielen Menschen.', 'Man kann auch gut Geld verdienen.', 'Ich muss gut Englisch und Deutsch sprechen.', 'Deshalb lerne ich seit einem Jahr Deutsch.', 'Früher wollte ich Pilot werden.'] },
    { id: 'p16', sem: 2, lesson: 8, topic: 'Was bedeutet eine gute Arbeit für Sie? Wie findet man den Job?', en: 'What does a good job mean to you? How do you find a job?',
      model: ['Eine gute Arbeit ist interessant.', 'Die Kollegen sind nett und der Chef ist professionell.', 'Man verdient gut Geld.', 'Man hat nicht zu viel Stress.', 'Die Arbeitszeit ist gut, zum Beispiel von neun bis fünf.', 'Wie findet man einen Job?', 'Man liest Stellenanzeigen im Internet.', 'Dann ruft man an und fragt: Ist die Stelle noch frei?', 'Man schreibt eine Bewerbung.', 'Man kann auch zuerst ein Praktikum machen.'] },
    { id: 'p17', sem: 2, lesson: 9, topic: 'Beschreiben Sie eine Traumreise (oder eine Reise, die Sie schon gemacht haben).', en: 'A dream trip (or a past trip): where, how, where you stay, cost, food, sights',
      model: ['Meine Traumreise geht nach Österreich, nach Salzburg.', 'Ich fliege mit dem Flugzeug nach Wien.', 'Dann fahre ich mit dem Zug nach Salzburg.', 'Ich wohne in einem Hotel im Zentrum.', 'Ein Einzelzimmer mit Frühstück kostet 90 Euro pro Nacht.', 'Ich esse im Restaurant Wiener Schnitzel und Apfelstrudel.', 'Ich besuche Mozarts Geburtshaus in der Getreidegasse.', 'Ich mache auch eine Führung durch die Stadt.', 'Im Winter möchte ich in den Alpen Snowboard fahren.', 'Die Reise kostet zusammen ungefähr 1000 Euro.'] },
    { id: 'p18', sem: 2, lesson: 9, topic: 'Ein Hotel. Wie muss ein gutes Hotel sein? Was kann man vor der Reise machen? Welche Regeln gibt es?', en: 'A hotel: what must a good hotel be like? What to do before the trip? Which rules are there?',
      model: ['Ein gutes Hotel muss sauber und ruhig sein.', 'Das Frühstück muss inklusive sein.', 'Das WLAN muss kostenlos sein.', 'Das Hotel liegt im Zentrum oder in der Nähe von Sehenswürdigkeiten.', 'Vor der Reise muss man die Bewertungen im Internet lesen.', 'Man muss ein Zimmer reservieren.', 'Im Hotel gibt es Regeln:', 'Beim Check-in muss man den Ausweis zeigen.', 'Man darf im Zimmer nicht rauchen.', 'Nach 22 Uhr muss man leise sein.', 'Man muss um 12 Uhr auschecken.'] },
    { id: 'p19', sem: 2, lesson: 10, topic: 'Wie sieht Ihr Monster aus? Welche Körperteile hat es?', en: 'Describe your monster: which body parts does it have?',
      model: ['Mein Monster heißt Max.', 'Es hat einen großen Kopf und drei Augen.', 'Seine Augen sind blau.', 'Es hat zwei große Ohren und keine Nase.', 'Sein Mund ist sehr groß und es hat viele Zähne.', 'Es hat vier Arme und zwei Beine.', 'Seine Hände haben sechs Finger.', 'Seine Füße sind sehr klein.', 'Es hat grüne Haare.', 'Aber mein Monster ist sehr nett!'] },
    { id: 'p20', sem: 2, lesson: 10, topic: 'Gesundes Leben: Was muss man machen, um fit und gesund zu bleiben? Was machen Sie, wenn Sie krank sind?', en: 'Healthy life: what should you do to stay fit? What do you do when you are ill?',
      model: ['Man soll viel Sport machen, zum Beispiel joggen oder schwimmen.', 'Man soll viel Wasser trinken.', 'Man soll viel Obst und Gemüse essen.', 'Man soll nicht rauchen.', 'Man muss viel schlafen.', 'Ich gehe dreimal pro Woche ins Fitnessstudio.', 'Wenn ich krank bin, bleibe ich zu Hause im Bett.', 'Ich trinke viel Tee.', 'Bei Fieber gehe ich zum Arzt.', 'Der Arzt sagt dann: Sie sollen Tabletten nehmen.'] },
  ],

  // ── Mündlich: Gespräch ──
  dialogue: {
    phrases: [
      { h: 'Making a plan (from your course sheet "Redemittel Verabredung")', rows: [
        ['Wollen wir am … zusammen …?', 'Shall we … together on …?'], ['Was schlägst du vor?', 'What do you suggest?'], ['Hast du am … Zeit?', 'Do you have time on …?'],
        ['Können wir nicht am … ?', 'Can\'t we … on …?'], ['Kannst du am … mitkommen?', 'Can you come along on …?'], ['Und wie ist es am …?', 'And how about …?'], ['Was hast du am … vor?', 'What are you doing on …?'],
      ] },
      { h: '(+) Saying yes', rows: [
        ['Ja, gerne.', 'Yes, gladly.'], ['Ja, gute Idee.', 'Yes, good idea.'], ['Das finde ich toll / prima.', 'I think that\'s great.'], ['Ja, mal sehen. Um wie viel Uhr denn?', 'Let\'s see. At what time?'],
        ['O ja, gerne, ich kann zum Beispiel um … Uhr.', 'Oh yes, I can at … for example.'], ['Schön. Sagen wir um …', 'Nice. Let\'s say at …'], ['Das passt gut.', 'That suits me.'],
      ] },
      { h: '(−) Saying no', rows: [
        ['Tut mir leid. Da kann ich nicht.', 'Sorry. I can\'t then.'], ['Da habe ich schon eine Verabredung / einen Termin.', 'I already have a date / appointment then.'], ['Da habe ich leider keine Zeit.', 'Unfortunately I have no time then.'],
        ['Das finde ich wirklich schade, aber da kann ich nicht.', 'That\'s a real pity, but I can\'t.'], ['Ich habe keine Lust.', 'I don\'t feel like it.'], ['Vielleicht das nächste Mal / morgen.', 'Maybe next time / tomorrow.'],
      ] },
      { h: 'Rescue phrases', rows: [
        ['Wie bitte?', 'Pardon?'], ['Können Sie das bitte wiederholen?', 'Could you repeat that, please?'], ['Sprechen Sie bitte langsam.', 'Please speak slowly.'], ['Was bedeutet …?', 'What does … mean?'], ['Ich weiß es nicht.', 'I don\'t know.'], ['Moment mal …', 'Just a moment …'],
      ] },
    ],
    activities: ['Tennis spielen', 'ein Picknick machen', 'Kaffee trinken', 'essen gehen', 'in ein Konzert gehen', 'eine Ausstellung besuchen', 'spazieren gehen', 'in den Zoo gehen', 'ins Museum gehen', 'zum Fußball gehen', 'ins Kino gehen', 'ins Schwimmbad gehen', 'in die Sauna gehen', 'zum Sport gehen', 'einkaufen gehen', 'Freunde treffen', 'eine Wanderung machen', 'in die Disco gehen'],
    scenarios: [
      { id: 'd1', lesson: 5, title: 'Eine Verabredung machen', en: 'Make a plan to do something together this week.',
        a: 'You want to go to the cinema with your partner. Suggest a day. You can\'t on Monday (Deutschkurs) and Wednesday (Arbeit).', b: 'You have Fußball on Tuesday and your parents visit on Friday. You are free on Wednesday and Thursday.',
        model: [['A', 'Hallo! Wollen wir zusammen ins Kino gehen?'], ['B', 'Ja, gute Idee! Wann hast du Zeit?'], ['A', 'Hast du am Dienstag Zeit?'], ['B', 'Tut mir leid, am Dienstag spiele ich Fußball. Und wie ist es am Mittwoch?'], ['A', 'Am Mittwoch kann ich leider nicht, da muss ich arbeiten. Können wir nicht am Donnerstag gehen?'], ['B', 'Ja, am Donnerstag passt es gut. Um wie viel Uhr denn?'], ['A', 'Sagen wir um sieben?'], ['B', 'Prima. Bis Donnerstag!']] },
      { id: 'd2', lesson: 2, title: 'Sich kennenlernen', en: 'Get to know each other: ask and answer about name, origin, home, family, job, hobbies.',
        a: 'Ask your partner 5 questions (Woher …? Wo …? Was … von Beruf? Hast du …? Was machst du gern …?).', b: 'Answer and ask back (Und du?).',
        model: [['A', 'Hallo, ich bin Oleg. Wie heißt du?'], ['B', 'Ich heiße Anna. Woher kommst du?'], ['A', 'Ich komme aus Russland, aus Sankt Petersburg. Und du?'], ['B', 'Ich komme aus Deutschland. Ich wohne in Berlin. Hast du Geschwister?'], ['A', 'Ja, ich habe eine Schwester. Was machst du gern in der Freizeit?'], ['B', 'Ich lese gern und ich schwimme. Und du?'], ['A', 'Ich fahre gern Snowboard.']] },
      { id: 'd3', lesson: 3, title: 'Im Supermarkt einkaufen', en: 'A: customer, B: shop assistant.',
        a: 'Buy: 1 kg apples, 6 eggs, milk. Ask the prices.', b: 'You have apples (2,50 €/kg) and eggs (1,89 €), but no milk today.',
        model: [['B', 'Guten Tag. Was möchten Sie?'], ['A', 'Ich brauche ein Kilo Äpfel. Was kostet ein Kilo?'], ['B', 'Zwei Euro fünfzig. Sonst noch etwas?'], ['A', 'Ja, sechs Eier, bitte. Und haben Sie Milch?'], ['B', 'Nein, tut mir leid. Milch haben wir heute nicht.'], ['A', 'Schade. Was macht das zusammen?'], ['B', 'Das macht vier Euro neununddreißig.']] },
      { id: 'd4', lesson: 6, title: 'Am Imbiss', en: 'Order food and drinks at a snack bar; talk about what you take.',
        a: 'You are hungry and thirsty. Order something and ask your partner what they take.', b: 'You only want a drink, no food.',
        model: [['A', 'Ich habe Hunger! Ich nehme die Würstchen mit Kartoffelsalat und einen Apfelsaft. Was nimmst du?'], ['B', 'Ich weiß nicht. Ich habe keinen Hunger. Ich nehme nur eine Cola.'], ['A', 'Hast du wirklich keinen Hunger?'], ['B', 'Nein. Aber ich habe Durst!']] },
      { id: 'd5', lesson: 8, title: 'Am Telefon: Ist die Stelle noch frei?', en: 'A calls about an internship ad; B is the company.',
        a: 'Ask: is the job free? how long? working hours? money?', b: 'Praktikum 2–4 Monate, Mo–Fr 8–17 Uhr, 500 Euro pro Monat. Bewerbung per E-Mail.',
        model: [['B', 'Firma Logistik Plus, guten Tag.'], ['A', 'Guten Tag, mein Name ist Ezhkov. Ich habe Ihre Anzeige gelesen. Ist die Stelle noch frei?'], ['B', 'Ja.'], ['A', 'Und wie lange dauert das Praktikum?'], ['B', 'Zwei bis vier Monate.'], ['A', 'Wie ist die Arbeitszeit?'], ['B', 'Von Montag bis Freitag von acht bis siebzehn Uhr.'], ['A', 'Bekomme ich für das Praktikum auch Geld?'], ['B', 'Ja, wir zahlen 500 Euro pro Monat. Schicken Sie Ihre Bewerbung bitte per E-Mail.'], ['A', 'Vielen Dank. Auf Wiederhören.']] },
      { id: 'd6', lesson: 9, title: 'An der Hotelrezeption', en: 'A: guest, B: receptionist.',
        a: 'You booked a single room. You want half board. Ask: breakfast from when to when?', b: 'The room is not ready yet → offer a coffee. Breakfast 8–10. Check-out 11 Uhr.',
        model: [['B', 'Guten Tag. Kann ich Ihnen helfen?'], ['A', 'Guten Tag. Ich habe ein Einzelzimmer reserviert. Mein Name ist Ezhkov.'], ['B', 'Ah ja. Das Zimmer ist leider noch nicht fertig. Möchten Sie so lange einen Kaffee trinken?'], ['A', 'Ja, gern.'], ['B', 'Möchten Sie Halbpension oder Vollpension?'], ['A', 'Halbpension, bitte. Von wann bis wann gibt es Frühstück?'], ['B', 'Von acht bis zehn Uhr.'], ['A', 'Und wann muss ich auschecken?'], ['B', 'Um elf Uhr.']] },
      { id: 'd7', lesson: 10, title: 'Einen Arzttermin vereinbaren', en: 'A calls a doctor\'s practice; B is the receptionist.',
        a: 'You have a toothache. You need an appointment urgently.', b: 'The next free appointment is tomorrow afternoon at 14:30.',
        model: [['B', 'Zahnarztpraxis Dr. Weber, guten Tag.'], ['A', 'Guten Tag, hier spricht Ezhkov. Ich habe starke Zahnschmerzen. Könnte ich bitte einen Termin haben?'], ['B', 'Der nächste freie Termin ist morgen Nachmittag um halb drei.'], ['A', 'Kann ich nicht früher kommen? Es ist dringend.'], ['B', 'Dann kommen Sie heute um 17 Uhr.'], ['A', 'Vielen Dank! Bis heute.']] },
      { id: 'd8', lesson: 4, title: 'Eine Wohnung zeigen', en: 'A shows their flat; B asks questions and gives opinions (gefallen).',
        a: 'Show your flat: rooms, furniture.', b: 'Ask where rooms are and say what you like / don\'t like.',
        model: [['A', 'Das ist meine Wohnung.'], ['B', 'Oh, schön! Wo ist denn die Küche?'], ['A', 'Hier. Und dort ist das Bad.'], ['B', 'Ist hier auch ein Balkon?'], ['A', 'Ja, natürlich. Der Balkon ist dort.'], ['B', 'Wie schön! Das Sofa gefällt mir sehr gut. Ist es neu?'], ['A', 'Ja. Und wie gefallen dir die Stühle?'], ['B', 'Nicht so gut. Sie sind sehr alt.']] },
    ],
  },
};
