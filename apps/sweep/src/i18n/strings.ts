// UI strings. English is the source. Hausa, Yoruba, Igbo and Nigerian Pidgin are MACHINE-DRAFTED and must be
// reviewed by native speakers before release; the app says so on the consent and About screens.

export type Lang = "en" | "ha" | "yo" | "ig" | "pcm";

export const LANGS: { code: Lang; name: string; speech: string; machineDrafted: boolean }[] = [
  { code: "en", name: "English", speech: "en-NG", machineDrafted: false },
  { code: "ha", name: "Hausa", speech: "ha", machineDrafted: true },
  { code: "yo", name: "Yorùbá", speech: "yo", machineDrafted: true },
  { code: "ig", name: "Igbo", speech: "ig", machineDrafted: true },
  { code: "pcm", name: "Naijá (Pidgin)", speech: "en-NG", machineDrafted: true },
];

export interface Strings {
  appName: string;
  machineDrafted: string;
  // consent
  chooseLanguage: string;
  consentTitle: string;
  consentIntro: string;
  collectHeading: string;
  collectItems: string[];
  notCollectHeading: string;
  notCollectItems: string[];
  dataCost: string;
  agree: string;
  // nav
  navFind: string;
  navContrib: string;
  navAbout: string;
  back: string;
  // find
  findTitle: string;
  nearby: string;
  searchLabel: string;
  searchButton: string;
  locating: string;
  noUnits: string;
  metresAway: (m: number) => string;
  needsTests: (n: number) => string;
  measured: string;
  noPoint: string;
  cachedList: string;
  refresh: string;
  // run
  runTitle: string;
  start: string;
  cancel: string;
  evening: string;
  phase: Record<
    "idle" | "locating" | "place_check" | "sampling" | "nonce" | "latency" | "upload" | "sealing" | "submitting" | "done" | "aborted",
    string
  >;
  simOf: (i: number, n: number) => string;
  abort: Record<
    "no_fix" | "low_accuracy" | "mock_location" | "outside_nigeria" | "too_far" | "no_sims" | "api_error" | "cancelled" | "permissions",
    string
  >;
  distanceNote: (m: number) => string;
  registering: string;
  registerFailed: string;
  // result
  resultTitle: string;
  statusAccepted: string;
  statusQuarantined: string;
  statusRejected: string;
  statusQueued: string;
  offlineRun: string;
  needsMore: (n: number) => string;
  unitMeasured: string;
  locationVote: string;
  signal: string;
  uploadTime: (s: number) => string;
  uploadFailed: (err: string) => string;
  done: string;
  // contributions
  contribTitle: string;
  empty: string;
  pending: string;
  synced: string;
  failed: string;
  syncNow: string;
  deleteData: string;
  deleteConfirm: string;
  deleted: (n: number) => string;
  deleteFailed: string;
  // about
  aboutTitle: string;
  methodHeading: string;
  method: string[];
  contact: string;
  dpo: string;
  version: string;
  deviceId: string;
  language: string;
  speakOn: string;
  speakOff: string;
  error: string;
}

const en: Strings = {
  appName: "Proof of Signal",
  machineDrafted: "",
  chooseLanguage: "Choose your language",
  consentTitle: "Before you start",
  consentIntro:
    "Proof of Signal checks whether a phone can upload results from your polling unit. You stand at the unit, press one button, and the phone measures the mobile network for about two minutes.",
  collectHeading: "What the app collects",
  collectItems: [
    "Your location during the test (exact location is deleted after 24 hours)",
    "Mobile network measurements: network, cell tower, signal strength, network type",
    "Upload speed of a test file made of random data",
    "A random device code made by the app (not your phone number or IMEI)",
  ],
  notCollectHeading: "What it never collects",
  notCollectItems: [
    "No voter data, no PVC, no ballots, no vote counts",
    "No name, phone number, contacts, photos or messages",
    "No location outside a test, and nothing in the background",
  ],
  dataCost: "Each test uses about 1.7 MB of data for each SIM in your phone.",
  agree: "I understand, continue",
  navFind: "Find unit",
  navContrib: "My tests",
  navAbout: "About",
  back: "Back",
  findTitle: "Find your polling unit",
  nearby: "Nearest units",
  searchLabel: "Search by unit code or name",
  searchButton: "Search",
  locating: "Finding where you are…",
  noUnits: "No units found. Try searching by code, for example 24-05-11-003.",
  metresAway: (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km away` : `${Math.round(m)} m away`),
  needsTests: (n) => (n === 1 ? "Needs 1 more test" : `Needs ${n} more tests`),
  measured: "Measured: thank you",
  noPoint: "Not on the map yet: your test will place it",
  cachedList: "Offline: showing units saved earlier",
  refresh: "Refresh",
  runTitle: "Run the test",
  start: "Start test",
  cancel: "Stop",
  evening: "Results upload after 5pm, so test then if you can.",
  phase: {
    idle: "Stand at the polling unit, then press Start.",
    locating: "Getting your location. Stay outside, away from walls.",
    place_check: "Checking you are at the polling unit.",
    sampling: "Measuring the signal. Keep the phone still.",
    nonce: "Getting a test code from the server.",
    latency: "Checking how fast the network answers.",
    upload: "Uploading the test file. This can take two minutes.",
    sealing: "Signing the result.",
    submitting: "Sending the result.",
    done: "Test finished. Thank you.",
    aborted: "The test stopped.",
  },
  simOf: (i, n) => `SIM ${i} of ${n}`,
  abort: {
    no_fix: "Could not get your location. Go outside, turn on location, and try again.",
    low_accuracy: "Location is not precise enough (needs 30 m). Move to open sky and try again.",
    mock_location: "A fake-location app is active. Turn it off to run a test.",
    outside_nigeria: "Your location is outside Nigeria.",
    too_far: "You are too far from this polling unit. Walk closer and try again.",
    no_sims: "No SIM card found. Insert a SIM and try again.",
    api_error: "The server refused the test.",
    cancelled: "Test stopped. Nothing was sent.",
    permissions: "The app needs location and phone permissions to measure the network.",
  },
  distanceNote: (m) => `You are ${Math.round(m)} m away; you need to be within 150 m.`,
  registering: "Setting up this phone…",
  registerFailed: "Could not set up this phone. Connect to the internet once, then try again.",
  resultTitle: "Result",
  statusAccepted: "Accepted",
  statusQuarantined: "Held for review",
  statusRejected: "Not counted",
  statusQueued: "Saved. It will send when you have a connection.",
  offlineRun: "No connection: the signal was measured, but the upload test needs a connection.",
  needsMore: (n) => (n === 1 ? "Your unit needs 1 more test." : `Your unit needs ${n} more tests.`),
  unitMeasured: "Your unit now has enough tests.",
  locationVote: "This unit had no map point. Your location helps place it.",
  signal: "Signal",
  uploadTime: (s) => `1.5 MB uploaded in ${s.toFixed(1)} s`,
  uploadFailed: (err) => `Upload failed (${err})`,
  done: "Done",
  contribTitle: "My tests",
  empty: "No tests yet.",
  pending: "Waiting to send",
  synced: "Sent",
  failed: "Not accepted",
  syncNow: "Send now",
  deleteData: "Delete my data",
  deleteConfirm: "Delete every test from this phone on the server and on this phone? This cannot be undone.",
  deleted: (n) => `Deleted ${n} tests.`,
  deleteFailed: "Could not delete. Connect to the internet and try again.",
  aboutTitle: "About",
  methodHeading: "How it works",
  method: [
    "Each test takes a precise location, five readings of every SIM's signal two seconds apart, three quick pings, and uploads a 1.5 MB file of random data on each SIM's mobile data.",
    "A unit counts as measured after three accepted tests taken between 5pm and midnight. A model estimates units nobody has tested yet.",
    "Results are signed on the phone so they cannot be changed in transit. Exact locations are deleted after 24 hours.",
    "On election night the dashboard only says whether a missing upload is explained by the network. It never shows vote figures.",
  ],
  contact: "Contact",
  dpo: "Data protection",
  version: "App version",
  deviceId: "Device code",
  language: "Language",
  speakOn: "Voice prompts on",
  speakOff: "Voice prompts off",
  error: "Something went wrong.",
};

const MD = "Machine-drafted translation: needs review by a native speaker.";

const ha: Strings = {
  ...en,
  machineDrafted: MD,
  chooseLanguage: "Zaɓi harshenka",
  consentTitle: "Kafin ka fara",
  consentIntro:
    "Proof of Signal yana duba ko waya za ta iya aika sakamako daga rumfar zaɓenka. Za ka tsaya a rumfar, ka danna maɓalli ɗaya, waya kuma za ta auna hanyar sadarwa na kusan mintuna biyu.",
  collectHeading: "Abin da manhajar ke tattarawa",
  collectItems: [
    "Wurin da kake yayin gwaji (ana goge ainihin wurin bayan awa 24)",
    "Bayanan hanyar sadarwa: kamfani, eriya, ƙarfin sigina, irin hanyar sadarwa",
    "Saurin aika fayil na gwaji da aka yi da bayanai marasa ma'ana",
    "Lambar na'ura da manhajar ta ƙirƙira (ba lambar wayarka ko IMEI ba)",
  ],
  notCollectHeading: "Abin da ba ta taɓa tattarawa",
  notCollectItems: [
    "Babu bayanan masu zaɓe, babu PVC, babu ƙuri'u, babu ƙidayar ƙuri'a",
    "Babu suna, lambar waya, abokan hulɗa, hotuna ko saƙonni",
    "Babu wuri a wajen gwaji, babu abin da ke gudana a ɓoye",
  ],
  dataCost: "Kowane gwaji yana amfani da kusan 1.7 MB na data ga kowane SIM a wayarka.",
  agree: "Na fahimta, ci gaba",
  navFind: "Nemo rumfa",
  navContrib: "Gwaje-gwajena",
  navAbout: "Game da",
  back: "Koma",
  findTitle: "Nemo rumfar zaɓenka",
  nearby: "Rumfuna mafi kusa",
  searchLabel: "Nema da lambar rumfa ko suna",
  searchButton: "Nema",
  locating: "Ana neman inda kake…",
  noUnits: "Ba a sami rumfa ba. Gwada nema da lamba, misali 24-05-11-003.",
  metresAway: (m) => (m >= 1000 ? `nisan km ${(m / 1000).toFixed(1)}` : `nisan mita ${Math.round(m)}`),
  needsTests: (n) => `Tana buƙatar ƙarin gwaji ${n}`,
  measured: "An auna: mun gode",
  noPoint: "Ba ta kan taswira tukuna: gwajinka zai sanya ta",
  cachedList: "Babu intanet: ana nuna rumfunan da aka adana",
  refresh: "Sabunta",
  runTitle: "Yi gwajin",
  start: "Fara gwaji",
  cancel: "Tsaya",
  evening: "Ana aika sakamako bayan ƙarfe 5 na yamma, don haka ka yi gwaji a lokacin idan za ka iya.",
  phase: {
    idle: "Tsaya a rumfar zaɓe, sannan ka danna Fara.",
    locating: "Ana samun wurinka. Ka tsaya a waje, nesa da bango.",
    place_check: "Ana tabbatar da cewa kana rumfar zaɓe.",
    sampling: "Ana auna sigina. Ka riƙe wayar a tsaye.",
    nonce: "Ana karɓar lambar gwaji daga sabar.",
    latency: "Ana duba saurin amsawar hanyar sadarwa.",
    upload: "Ana aika fayil na gwaji. Zai iya ɗaukar mintuna biyu.",
    sealing: "Ana sa hannu kan sakamakon.",
    submitting: "Ana aika sakamakon.",
    done: "An gama gwaji. Mun gode.",
    aborted: "Gwajin ya tsaya.",
  },
  simOf: (i, n) => `SIM ${i} cikin ${n}`,
  abort: {
    no_fix: "Ba a sami wurinka ba. Fita waje, kunna location, sannan ka sake gwadawa.",
    low_accuracy: "Wurin bai yi daidai sosai ba (ana buƙatar mita 30). Matsa zuwa fili ka sake gwadawa.",
    mock_location: "Wata manhajar wurin ƙarya tana aiki. Kashe ta don yin gwaji.",
    outside_nigeria: "Wurinka yana wajen Najeriya.",
    too_far: "Ka yi nisa da wannan rumfar zaɓe. Matso kusa ka sake gwadawa.",
    no_sims: "Ba a sami katin SIM ba. Saka SIM ka sake gwadawa.",
    api_error: "Sabar ta ƙi karɓar gwajin.",
    cancelled: "An tsayar da gwaji. Ba a aika komai ba.",
    permissions: "Manhajar tana buƙatar izinin wuri da na waya don auna hanyar sadarwa.",
  },
  distanceNote: (m) => `Kana nisan mita ${Math.round(m)}; dole ka kasance cikin mita 150.`,
  registering: "Ana shirya wannan waya…",
  registerFailed: "Ba a iya shirya wannan waya ba. Haɗa da intanet sau ɗaya, sannan ka sake gwadawa.",
  resultTitle: "Sakamako",
  statusAccepted: "An karɓa",
  statusQuarantined: "An ajiye don dubawa",
  statusRejected: "Ba a ƙidaya ba",
  statusQueued: "An adana. Za a aika idan ka sami intanet.",
  offlineRun: "Babu intanet: an auna sigina, amma gwajin aikawa yana buƙatar intanet.",
  needsMore: (n) => `Rumfarka tana buƙatar ƙarin gwaji ${n}.`,
  unitMeasured: "Rumfarka yanzu tana da isassun gwaje-gwaje.",
  locationVote: "Wannan rumfa ba ta da wuri a taswira. Wurinka zai taimaka a sanya ta.",
  signal: "Sigina",
  uploadTime: (s) => `An aika 1.5 MB cikin daƙiƙa ${s.toFixed(1)}`,
  uploadFailed: (err) => `Aikawa ta kasa (${err})`,
  done: "An gama",
  contribTitle: "Gwaje-gwajena",
  empty: "Babu gwaji tukuna.",
  pending: "Yana jiran aikawa",
  synced: "An aika",
  failed: "Ba a karɓa ba",
  syncNow: "Aika yanzu",
  deleteData: "Goge bayanaina",
  deleteConfirm: "A goge duk gwaje-gwajen wannan waya a sabar da kuma a wayar? Ba za a iya maido su ba.",
  deleted: (n) => `An goge gwaje-gwaje ${n}.`,
  deleteFailed: "Ba a iya gogewa ba. Haɗa da intanet ka sake gwadawa.",
  aboutTitle: "Game da manhajar",
  methodHeading: "Yadda take aiki",
  contact: "Tuntuɓa",
  dpo: "Kariyar bayanai",
  version: "Sigar manhaja",
  deviceId: "Lambar na'ura",
  language: "Harshe",
  speakOn: "Muryar jagora a kunne",
  speakOff: "Muryar jagora a kashe",
  error: "An sami matsala.",
};

const yo: Strings = {
  ...en,
  machineDrafted: MD,
  chooseLanguage: "Yan èdè rẹ",
  consentTitle: "Kí o tó bẹ̀rẹ̀",
  consentIntro:
    "Proof of Signal ń ṣàyẹ̀wò bóyá fóònù lè fi èsì ránṣẹ́ láti ibùdó ìdìbò rẹ. O máa dúró ní ibùdó náà, tẹ bọ́tìnnì kan, fóònù á sì wọn nẹ́tíwọ̀ọ̀kì fún bí ìṣẹ́jú méjì.",
  collectHeading: "Ohun tí áàpù náà ń gbà",
  collectItems: [
    "Ibi tí o wà nígbà àyẹ̀wò (a máa pa ibi gangan rẹ́ lẹ́yìn wákàtí 24)",
    "Ìwọ̀n nẹ́tíwọ̀ọ̀kì: ilé-iṣẹ́, ẹ̀rọ àgbéká, agbára àmì, irú nẹ́tíwọ̀ọ̀kì",
    "Ìyára fífi fáìlì àyẹ̀wò tí a fi dátà àìrọ́nà ṣe ránṣẹ́",
    "Kóòdù ẹ̀rọ tí áàpù ṣe (kì í ṣe nọ́ńbà fóònù rẹ tàbí IMEI)",
  ],
  notCollectHeading: "Ohun tí kò ní gbà láéláé",
  notCollectItems: [
    "Kò sí dátà olùdìbò, kò sí PVC, kò sí ìwé ìdìbò, kò sí iye ìbò",
    "Kò sí orúkọ, nọ́ńbà fóònù, àwọn olùbásọ̀rọ̀, àwòrán tàbí ìfiránṣẹ́",
    "Kò sí ibi tí o wà lẹ́yìn àyẹ̀wò, kò sí ohunkóhun ní abẹ́lẹ̀",
  ],
  dataCost: "Àyẹ̀wò kọ̀ọ̀kan ń lo nǹkan bí 1.7 MB dátà fún SIM kọ̀ọ̀kan nínú fóònù rẹ.",
  agree: "Mo yé mi, tẹ̀síwájú",
  navFind: "Wá ibùdó",
  navContrib: "Àyẹ̀wò mi",
  navAbout: "Nípa",
  back: "Padà",
  findTitle: "Wá ibùdó ìdìbò rẹ",
  nearby: "Àwọn ibùdó tó súnmọ́ jù",
  searchLabel: "Wá pẹ̀lú kóòdù ibùdó tàbí orúkọ",
  searchButton: "Wá",
  locating: "À ń wá ibi tí o wà…",
  noUnits: "A kò rí ibùdó kankan. Gbìyànjú pẹ̀lú kóòdù, fún àpẹẹrẹ 24-05-11-003.",
  metresAway: (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km sí ibí` : `${Math.round(m)} m sí ibí`),
  needsTests: (n) => `Ó nílò àyẹ̀wò ${n} sí i`,
  measured: "A ti wọ̀n ọ́n: ẹ ṣé",
  noPoint: "Kò sí lórí máàpù síbẹ̀: àyẹ̀wò rẹ á fi sí i",
  cachedList: "Kò sí íńtánẹ́ẹ̀tì: à ń fi àwọn ibùdó tí a fi pamọ́ hàn",
  refresh: "Sọ di tuntun",
  runTitle: "Ṣe àyẹ̀wò",
  start: "Bẹ̀rẹ̀ àyẹ̀wò",
  cancel: "Dúró",
  evening: "Èsì máa ń lọ lẹ́yìn agogo márùn-ún ìrọ̀lẹ́, nítorí náà ṣe àyẹ̀wò nígbà náà tí o bá lè ṣe é.",
  phase: {
    idle: "Dúró ní ibùdó ìdìbò, lẹ́yìn náà tẹ Bẹ̀rẹ̀.",
    locating: "À ń gba ibi tí o wà. Dúró níta, jìnnà sí ògiri.",
    place_check: "À ń ṣàyẹ̀wò pé o wà ní ibùdó ìdìbò.",
    sampling: "À ń wọn àmì. Mú fóònù dúró jẹ́ẹ́.",
    nonce: "À ń gba kóòdù àyẹ̀wò láti ọ̀dọ̀ olùpín.",
    latency: "À ń wo bí nẹ́tíwọ̀ọ̀kì ṣe ń dáhùn kíákíá.",
    upload: "À ń fi fáìlì àyẹ̀wò ránṣẹ́. Ó lè gba ìṣẹ́jú méjì.",
    sealing: "À ń fọwọ́ sí èsì náà.",
    submitting: "À ń fi èsì ránṣẹ́.",
    done: "Àyẹ̀wò ti parí. Ẹ ṣé.",
    aborted: "Àyẹ̀wò dúró.",
  },
  simOf: (i, n) => `SIM ${i} nínú ${n}`,
  abort: {
    no_fix: "A kò rí ibi tí o wà. Jáde síta, tan location, kí o sì tún gbìyànjú.",
    low_accuracy: "Ibi tí o wà kò péye tó (ó nílò 30 m). Lọ sí ibi gbangba kí o tún gbìyànjú.",
    mock_location: "Áàpù ibi-ayédèrú kan ń ṣiṣẹ́. Pa á kí o tó ṣe àyẹ̀wò.",
    outside_nigeria: "Ibi tí o wà kò sí ní Nàìjíríà.",
    too_far: "O jìnnà jù sí ibùdó ìdìbò yìí. Súnmọ́ ọn kí o tún gbìyànjú.",
    no_sims: "A kò rí káàdì SIM. Fi SIM sí i kí o tún gbìyànjú.",
    api_error: "Olùpín kọ àyẹ̀wò náà.",
    cancelled: "A dá àyẹ̀wò dúró. Kò sí ohun tí a fi ránṣẹ́.",
    permissions: "Áàpù nílò àṣẹ location àti fóònù láti wọn nẹ́tíwọ̀ọ̀kì.",
  },
  distanceNote: (m) => `O wà ní ${Math.round(m)} m; o gbọ́dọ̀ wà láàrin 150 m.`,
  registering: "À ń ṣètò fóònù yìí…",
  registerFailed: "A kò lè ṣètò fóònù yìí. So mọ́ íńtánẹ́ẹ̀tì lẹ́ẹ̀kan, kí o tún gbìyànjú.",
  resultTitle: "Èsì",
  statusAccepted: "A ti gbà á",
  statusQuarantined: "A fi pamọ́ fún àyẹ̀wò",
  statusRejected: "A kò kà á",
  statusQueued: "A ti fi pamọ́. Yóò lọ nígbà tí o bá ní íńtánẹ́ẹ̀tì.",
  offlineRun: "Kò sí íńtánẹ́ẹ̀tì: a wọn àmì, ṣùgbọ́n àyẹ̀wò fífi ránṣẹ́ nílò íńtánẹ́ẹ̀tì.",
  needsMore: (n) => `Ibùdó rẹ nílò àyẹ̀wò ${n} sí i.`,
  unitMeasured: "Ibùdó rẹ ti ní àyẹ̀wò tó tó báyìí.",
  locationVote: "Ibùdó yìí kò ní ààyè lórí máàpù. Ibi tí o wà ń ràn án lọ́wọ́.",
  signal: "Àmì",
  uploadTime: (s) => `A fi 1.5 MB ránṣẹ́ ní ìṣẹ́jú-àáyá ${s.toFixed(1)}`,
  uploadFailed: (err) => `Fífi ránṣẹ́ kùnà (${err})`,
  done: "Ó ti parí",
  contribTitle: "Àyẹ̀wò mi",
  empty: "Kò sí àyẹ̀wò síbẹ̀.",
  pending: "Ó ń dúró láti lọ",
  synced: "Ó ti lọ",
  failed: "A kò gbà á",
  syncNow: "Fi ránṣẹ́ báyìí",
  deleteData: "Pa dátà mi rẹ́",
  deleteConfirm: "Pa gbogbo àyẹ̀wò fóònù yìí rẹ́ lórí olùpín àti lórí fóònù yìí? A kò lè dá a padà.",
  deleted: (n) => `A ti pa àyẹ̀wò ${n} rẹ́.`,
  deleteFailed: "A kò lè pa á rẹ́. So mọ́ íńtánẹ́ẹ̀tì kí o tún gbìyànjú.",
  aboutTitle: "Nípa áàpù yìí",
  methodHeading: "Bí ó ṣe ń ṣiṣẹ́",
  contact: "Kàn sí wa",
  dpo: "Ààbò dátà",
  version: "Ẹ̀dà áàpù",
  deviceId: "Kóòdù ẹ̀rọ",
  language: "Èdè",
  speakOn: "Ohùn ìtọ́sọ́nà wà ní títàn",
  speakOff: "Ohùn ìtọ́sọ́nà wà ní píparẹ́",
  error: "Nǹkan kan ṣẹlẹ̀.",
};

const ig: Strings = {
  ...en,
  machineDrafted: MD,
  chooseLanguage: "Họrọ asụsụ gị",
  consentTitle: "Tupu ịmalite",
  consentIntro:
    "Proof of Signal na-enyocha ma ekwentị nwere ike iziga nsonaazụ site na ebe ntuli aka gị. Ị ga-eguzo n'ebe ahụ, pịa otu bọtịnụ, ekwentị ga-atụ netwọk ihe dị ka nkeji abụọ.",
  collectHeading: "Ihe ngwa a na-anakọta",
  collectItems: [
    "Ebe ị nọ n'oge nnwale (a na-ehichapụ ebe kpọmkwem mgbe awa 24 gasịrị)",
    "Ntụle netwọk: ụlọ ọrụ, ụlọ elu ekwentị, ike mgbaàmà, ụdị netwọk",
    "Ọsọ iziga faịlụ nnwale e ji data enweghị isi mee",
    "Koodu ngwaọrụ ngwa ahụ mepụtara (ọ bụghị nọmba ekwentị gị ma ọ bụ IMEI)",
  ],
  notCollectHeading: "Ihe ọ naghị anakọta",
  notCollectItems: [
    "Enweghị data ndị ntuli aka, enweghị PVC, enweghị akwụkwọ ntuli, enweghị ọnụ ọgụgụ votu",
    "Enweghị aha, nọmba ekwentị, kọntaktị, foto ma ọ bụ ozi",
    "Enweghị ebe ị nọ ma ọ bụghị n'oge nnwale, ọ dịghị ihe na-agba n'azụ",
  ],
  dataCost: "Nnwale ọ bụla na-eji ihe dị ka 1.7 MB data maka SIM ọ bụla dị n'ekwentị gị.",
  agree: "Aghọtara m, gaa n'ihu",
  navFind: "Chọta ebe",
  navContrib: "Nnwale m",
  navAbout: "Maka",
  back: "Laghachi",
  findTitle: "Chọta ebe ntuli aka gị",
  nearby: "Ebe ndị kacha nso",
  searchLabel: "Chọọ site na koodu ebe ma ọ bụ aha",
  searchButton: "Chọọ",
  locating: "Anyị na-achọ ebe ị nọ…",
  noUnits: "Ahụghị ebe ọ bụla. Nwaa ịchọ site na koodu, dịka 24-05-11-003.",
  metresAway: (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km site ebe a` : `${Math.round(m)} m site ebe a`),
  needsTests: (n) => `Ọ chọrọ nnwale ${n} ọzọ`,
  measured: "Atụọla ya: daalụ",
  noPoint: "Ọ nọbeghị na map: nnwale gị ga-etinye ya",
  cachedList: "Enweghị ịntanetị: na-egosi ebe echekwara na mbụ",
  refresh: "Mee ọhụrụ",
  runTitle: "Mee nnwale",
  start: "Malite nnwale",
  cancel: "Kwụsị",
  evening: "A na-ezipụ nsonaazụ mgbe elekere ise nke mgbede gachara, ya mere mee nnwale n'oge ahụ ma ọ bụrụ na ị nwere ike.",
  phase: {
    idle: "Guzoro n'ebe ntuli aka, wee pịa Malite.",
    locating: "Anyị na-enweta ebe ị nọ. Nọrọ n'èzí, pụọ na mgbidi.",
    place_check: "Anyị na-enyocha na ị nọ n'ebe ntuli aka.",
    sampling: "Anyị na-atụ mgbaàmà. Jide ekwentị ka ọ kwụsie ike.",
    nonce: "Anyị na-enweta koodu nnwale site na sava.",
    latency: "Anyị na-enyocha ka netwọk si azaghachi ọsọ ọsọ.",
    upload: "Anyị na-eziga faịlụ nnwale. Ọ nwere ike were nkeji abụọ.",
    sealing: "Anyị na-abịanye aka na nsonaazụ.",
    submitting: "Anyị na-eziga nsonaazụ.",
    done: "Nnwale agwụla. Daalụ.",
    aborted: "Nnwale kwụsịrị.",
  },
  simOf: (i, n) => `SIM ${i} n'ime ${n}`,
  abort: {
    no_fix: "Enwetaghị ebe ị nọ. Pụọ n'èzí, gbanye location, wee nwaa ọzọ.",
    low_accuracy: "Ebe ị nọ ezighi ezi nke ọma (ọ chọrọ 30 m). Gaa ebe mepere emepe wee nwaa ọzọ.",
    mock_location: "Ngwa ebe ụgha na-arụ ọrụ. Gbanyụọ ya iji mee nnwale.",
    outside_nigeria: "Ebe ị nọ dị na mpụga Naịjirịa.",
    too_far: "Ị nọ ebe dị anya site n'ebe ntuli aka a. Bịaruo nso wee nwaa ọzọ.",
    no_sims: "Ahụghị kaadị SIM. Tinye SIM wee nwaa ọzọ.",
    api_error: "Sava jụrụ nnwale ahụ.",
    cancelled: "Akwụsịrị nnwale. Ezigaghị ihe ọ bụla.",
    permissions: "Ngwa a chọrọ ikike location na ekwentị iji tụọ netwọk.",
  },
  distanceNote: (m) => `Ị nọ ${Math.round(m)} m; ị ga-anọrịrị n'ime 150 m.`,
  registering: "Anyị na-edozi ekwentị a…",
  registerFailed: "Enweghị ike idozi ekwentị a. Jikọọ na ịntanetị otu ugboro, wee nwaa ọzọ.",
  resultTitle: "Nsonaazụ",
  statusAccepted: "Anabatara ya",
  statusQuarantined: "Edebere ya maka nyocha",
  statusRejected: "Agụghị ya",
  statusQueued: "Echekwara ya. Ọ ga-aga mgbe ị nwere ịntanetị.",
  offlineRun: "Enweghị ịntanetị: atụrụ mgbaàmà, mana nnwale iziga chọrọ ịntanetị.",
  needsMore: (n) => `Ebe gị chọrọ nnwale ${n} ọzọ.`,
  unitMeasured: "Ebe gị nwere nnwale zuru oke ugbu a.",
  locationVote: "Ebe a enweghị ọnọdụ na map. Ebe ị nọ na-enyere aka itinye ya.",
  signal: "Mgbaàmà",
  uploadTime: (s) => `Ezigara 1.5 MB n'ime sekọnd ${s.toFixed(1)}`,
  uploadFailed: (err) => `Iziga dara (${err})`,
  done: "Emechaala",
  contribTitle: "Nnwale m",
  empty: "Enweghị nnwale ugbu a.",
  pending: "Na-eche iziga",
  synced: "Ezigara",
  failed: "Anabataghị",
  syncNow: "Ziga ugbu a",
  deleteData: "Hichapụ data m",
  deleteConfirm: "Hichapụ nnwale niile nke ekwentị a na sava na n'ekwentị a? Enweghị ike ịlaghachi ya.",
  deleted: (n) => `Ehichapụrụ nnwale ${n}.`,
  deleteFailed: "Enweghị ike ihichapụ. Jikọọ na ịntanetị wee nwaa ọzọ.",
  aboutTitle: "Maka ngwa a",
  methodHeading: "Otu o si arụ ọrụ",
  contact: "Kpọtụrụ anyị",
  dpo: "Nchekwa data",
  version: "Ụdị ngwa",
  deviceId: "Koodu ngwaọrụ",
  language: "Asụsụ",
  speakOn: "Olu nduzi gbanyere",
  speakOff: "Olu nduzi gbanyụrụ",
  error: "Ihe adịghị mma mere.",
};

const pcm: Strings = {
  ...en,
  machineDrafted: MD,
  chooseLanguage: "Choose your language",
  consentTitle: "Before you start",
  consentIntro:
    "Proof of Signal dey check whether phone fit send result comot from your polling unit. You go stand for the unit, press one button, and the phone go measure the network for like two minutes.",
  collectHeading: "Wetin the app dey collect",
  collectItems: [
    "Where you dey during the test (we go delete the exact place after 24 hours)",
    "Network matter: which network, which mast, how signal strong, which type of network",
    "How fast test file wey get only random data go upload",
    "One random device code wey the app make (no be your phone number or IMEI)",
  ],
  notCollectHeading: "Wetin e no dey ever collect",
  notCollectItems: [
    "No voter data, no PVC, no ballot, no vote count",
    "No name, phone number, contacts, photos or messages",
    "No location outside test time, nothing dey run for background",
  ],
  dataCost: "Every test dey use like 1.7 MB data for each SIM wey dey your phone.",
  agree: "I don understand, make we go",
  navFind: "Find unit",
  navContrib: "My tests",
  navAbout: "About",
  back: "Go back",
  findTitle: "Find your polling unit",
  nearby: "Units wey near you",
  searchLabel: "Search with unit code or name",
  searchButton: "Search",
  locating: "We dey find where you dey…",
  noUnits: "We no see any unit. Try search with code, like 24-05-11-003.",
  metresAway: (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km from here` : `${Math.round(m)} m from here`),
  needsTests: (n) => `E still need ${n} more test`,
  measured: "We don measure am: thank you",
  noPoint: "E never dey map: your test go put am",
  cachedList: "No network: na units wey we save before we dey show",
  refresh: "Refresh",
  runTitle: "Do the test",
  start: "Start test",
  cancel: "Stop",
  evening: "Results dey upload after 5pm, so do the test that time if you fit.",
  phase: {
    idle: "Stand for the polling unit, then press Start.",
    locating: "We dey find your location. Stay outside, far from wall.",
    place_check: "We dey check say you dey the polling unit.",
    sampling: "We dey measure signal. Hold the phone steady.",
    nonce: "We dey collect test code from server.",
    latency: "We dey check how fast network dey answer.",
    upload: "We dey upload the test file. E fit take two minutes.",
    sealing: "We dey sign the result.",
    submitting: "We dey send the result.",
    done: "Test don finish. Thank you.",
    aborted: "Test don stop.",
  },
  simOf: (i, n) => `SIM ${i} for ${n}`,
  abort: {
    no_fix: "We no fit get your location. Go outside, on location, then try again.",
    low_accuracy: "Location never correct reach (e need 30 m). Go open place try again.",
    mock_location: "One fake-location app dey on. Off am before you do test.",
    outside_nigeria: "Your location no dey Nigeria.",
    too_far: "You dey too far from this polling unit. Waka come near, then try again.",
    no_sims: "We no see SIM. Put SIM then try again.",
    api_error: "Server no gree collect the test.",
    cancelled: "Test don stop. Nothing go.",
    permissions: "The app need location and phone permission to measure network.",
  },
  distanceNote: (m) => `You dey ${Math.round(m)} m away; you need dey inside 150 m.`,
  registering: "We dey set up this phone…",
  registerFailed: "We no fit set up this phone. Connect to internet one time, then try again.",
  resultTitle: "Result",
  statusAccepted: "E don enter",
  statusQuarantined: "We hold am for check",
  statusRejected: "We no count am",
  statusQueued: "We don save am. E go send when network show.",
  offlineRun: "No network: we measure signal, but upload test need network.",
  needsMore: (n) => `Your unit still need ${n} more test.`,
  unitMeasured: "Your unit don get enough test now.",
  locationVote: "This unit no get map point before. Your location go help put am.",
  signal: "Signal",
  uploadTime: (s) => `1.5 MB upload for ${s.toFixed(1)} seconds`,
  uploadFailed: (err) => `Upload no work (${err})`,
  done: "Done",
  contribTitle: "My tests",
  empty: "No test yet.",
  pending: "E dey wait to send",
  synced: "E don send",
  failed: "Dem no accept am",
  syncNow: "Send am now",
  deleteData: "Delete my data",
  deleteConfirm: "Delete all test from this phone for server and for this phone? You no fit bring am back.",
  deleted: (n) => `We don delete ${n} test.`,
  deleteFailed: "We no fit delete. Connect to internet then try again.",
  aboutTitle: "About",
  methodHeading: "How e dey work",
  contact: "Contact",
  dpo: "Data protection",
  version: "App version",
  deviceId: "Device code",
  language: "Language",
  speakOn: "Voice guide dey on",
  speakOff: "Voice guide dey off",
  error: "Something no work.",
};

export const STRINGS: Record<Lang, Strings> = { en, ha, yo, ig, pcm };
