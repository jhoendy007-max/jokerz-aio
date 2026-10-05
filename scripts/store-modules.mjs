/** One store = one harvest site, cookie jar, bank lane. Do not mix Target with others. */
export function storeKey(module) {
  const m = String(module || "").toLowerCase();
  if (m.includes("walmart")) return "walmart";
  if (m.includes("pokemon") || m.includes("pkc")) return "pokemon";
  if (m.includes("bandai")) return "bandai";
  return "target";
}

export const STORES = {
  target: {
    id: "target",
    home: "https://www.target.com/",
    login: "https://www.target.com/login",
    cookieHost: /target\.com/i,
    antibot: "shape+px",
  },
  walmart: {
    id: "walmart",
    home: "https://www.walmart.com/",
    login: "https://www.walmart.com/account/signin",
    cookieHost: /walmart\.com/i,
    antibot: "px",
  },
  pokemon: {
    id: "pokemon",
    home: "https://www.pokemoncenter.com/",
    login: "https://www.pokemoncenter.com/login",
    cookieHost: /pokemoncenter\.com/i,
    antibot: "datadome",
  },
  bandai: {
    id: "bandai",
    home: "https://p-bandai.com/us",
    login: "https://p-bandai.com/us/login",
    cookieHost: /p-bandai\.com/i,
    antibot: "light",
  },
};

const TARGET_PDP = ["14753310", "12953964", "76130492", "54362597", "81827799"];
const WALMART_IP = ["44390949", "104511090", "582032580", "14924176"];

export function harvestPdp(store) {
  if (store === "walmart") {
    const id = WALMART_IP[Math.floor(Math.random() * WALMART_IP.length)];
    return `https://www.walmart.com/ip/${id}`;
  }
  if (store === "pokemon") return "https://www.pokemoncenter.com/";
  if (store === "bandai") return "https://p-bandai.com/us";
  const tcin = TARGET_PDP[Math.floor(Math.random() * TARGET_PDP.length)];
  return `https://www.target.com/p/-/A-${tcin}`;
}

export function harvestLogin(store) {
  return (STORES[store] || STORES.target).login;
}

export function harvestHome(store) {
  return (STORES[store] || STORES.target).home;
}

export function persistStoreName(store) {
  if (store === "walmart") return "Walmart";
  if (store === "pokemon") return "Pokemon Center";
  if (store === "bandai") return "Bandai";
  return "Target";
}
