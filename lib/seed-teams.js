// A starter list of active/notable Nitro Type team tags, hand-collected
// from public leaderboard data so the extension's "Browse teams" list
// isn't empty on day one. This is NOT a claim that it's every team in
// the game — nobody publishes that list without either an authenticated
// session token (the game's own in-client team search needs one) or a
// third-party feed this extension deliberately doesn't scrape. The
// directory keeps growing from here: every team you look up, and every
// team page you visit on nitrotype.com, gets added permanently to your
// own local list (see TeamDirectory in content/inject.js).
const SEED_TEAM_TAGS = [
  "12AMS", "1710", "3PEAT", "4X", "AC3R5", "ADRAGO", "APOC", "ARMD", "B2T", "BEEHVE",
  "BEGO0D", "BLZ", "BN8", "BN8OLD", "BXR", "CX", "CZBZ", "DAWN", "DAWN2", "DMP",
  "DN1", "DR1FTX", "E10", "ELV", "ESC", "ESOUP", "EVOQ", "FASZ", "FBSLCH", "FL4ME5",
  "GRAF", "HELIOS", "HPD", "HV", "HYP3Z", "IBM", "IGL", "IM4GOD", "IMT", "IPX",
  "JCLU", "JRXC", "KEYCAT", "KITTYI", "KN", "KU", "KZ", "LEROY", "LOVGOD", "LUXRY",
  "M0ON", "MDTP", "MED13L", "MEYBO", "N8TE", "NH", "NHS", "NMV", "NOHOPE", "NTC",
  "NTCORE", "NTHP", "NTM", "NTPD1", "NTPD2", "NTR", "NTRO", "NTV3", "NYM", "OCE8N",
  "OVRMEN", "P1RC", "P1RE", "PCHS1", "PIGFLY", "PR2W", "PRAI5E", "PVPSMP", "QXI", "RFTP",
  "RL", "RL1", "RSZ", "RTX", "RWD", "S0CCER", "S0RC", "SENZ", "SMASHO", "SRGEND",
  "SSH", "SSHR", "SUMMA", "SVC", "SVRN", "SWD", "SZM", "TALK", "TBZ", "TCHK",
  "TCHR", "TESM", "TFV", "THB0S", "THISKS", "TOPGOD", "TTT0", "TVX", "TYPIS", "TYPSQD",
  "V0R7EX", "VFL", "VL", "VT", "W1NN6R", "WAMZ", "WEALTH", "WIZ17", "WTTC", "XI",
  "XNTZ", "XREVX", "XTM", "XW", "XZDX", "YSOEZ", "YT", "ZH", "ZSH",
];
