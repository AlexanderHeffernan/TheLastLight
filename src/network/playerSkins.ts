import alexanderHeffernanSkinUrl from '../assets/characters/skins/alexander_heffernan_64.png';
import apartmentSurvivorSkinUrl from '../assets/characters/skins/apartment_survivor_64.png';
import blockGuardianSkinUrl from '../assets/characters/skins/block_guardian_64.png';
import caraLillSkinUrl from '../assets/characters/skins/cara_lill_64.png';
import courierSkinUrl from '../assets/characters/skins/courier_64.png';
import fieldMedicSkinUrl from '../assets/characters/skins/field_medic_64.png';
import galenGreenSkinUrl from '../assets/characters/skins/galen_green_64.png';
import homesteaderSkinUrl from '../assets/characters/skins/homesteader_64.png';
import hunterSkinUrl from '../assets/characters/skins/hunter_64.png';
import mechanicSkinUrl from '../assets/characters/skins/mechanic_64.png';
import oliverHeffernanSkinUrl from '../assets/characters/skins/oliver_heffernan_64.png';
import topdownSoldierSkinUrl from '../assets/characters/skins/topdown_soldier_64.png';
import urbanClimberSkinUrl from '../assets/characters/skins/urban_climber_64.png';
import { SECRET_PLAYER_SKIN_IDS } from '../shared/playerSkinIds';

export interface PlayerSkin {
  id: string;
  name: string;
  textureKey: string;
  color: number;
  hex: string;
  secret: boolean;
}

const skinPreviewUrls: Record<string, string> = {
  topdown_soldier: topdownSoldierSkinUrl,
  field_medic: fieldMedicSkinUrl,
  mechanic: mechanicSkinUrl,
  homesteader: homesteaderSkinUrl,
  apartment_survivor: apartmentSurvivorSkinUrl,
  hunter: hunterSkinUrl,
  urban_climber: urbanClimberSkinUrl,
  block_guardian: blockGuardianSkinUrl,
  courier: courierSkinUrl,
  alexander_heffernan: alexanderHeffernanSkinUrl,
  galen_green: galenGreenSkinUrl,
  cara_lill: caraLillSkinUrl,
  oliver_heffernan: oliverHeffernanSkinUrl,
};

const publicSkins: PlayerSkin[] = [
  {
    id: 'topdown_soldier',
    name: 'Veteran',
    textureKey: 'skin-topdown-soldier',
    color: 0x9a5a32,
    hex: '#9A5A32',
    secret: false,
  },
  {
    id: 'field_medic',
    name: 'Field Medic',
    textureKey: 'skin-field-medic',
    color: 0xc23b3b,
    hex: '#C23B3B',
    secret: false,
  },
  {
    id: 'mechanic',
    name: 'Mechanic',
    textureKey: 'skin-mechanic',
    color: 0xe07a28,
    hex: '#E07A28',
    secret: false,
  },
  {
    id: 'homesteader',
    name: 'Homesteader',
    textureKey: 'skin-homesteader',
    color: 0xc5a15a,
    hex: '#C5A15A',
    secret: false,
  },
  {
    id: 'apartment_survivor',
    name: 'Apartment Survivor',
    textureKey: 'skin-apartment-survivor',
    color: 0x74615c,
    hex: '#74615C',
    secret: false,
  },
  {
    id: 'hunter',
    name: 'Hunter',
    textureKey: 'skin-hunter',
    color: 0x6e7d32,
    hex: '#6E7D32',
    secret: false,
  },
  {
    id: 'urban_climber',
    name: 'Urban Climber',
    textureKey: 'skin-urban-climber',
    color: 0xf2c230,
    hex: '#F2C230',
    secret: false,
  },
  {
    id: 'block_guardian',
    name: 'Block Guardian',
    textureKey: 'skin-block-guardian',
    color: 0x6d6578,
    hex: '#6D6578',
    secret: false,
  },
  {
    id: 'courier',
    name: 'Courier',
    textureKey: 'skin-courier',
    color: 0x247c7a,
    hex: '#247C7A',
    secret: false,
  },
];

const secretSkins: PlayerSkin[] = [
  {
    id: 'alexander_heffernan',
    name: 'Alex Heffernan',
    textureKey: 'skin-alexander-heffernan',
    color: 0xf2e6d0,
    hex: '#F2E6D0',
    secret: true,
  },
  {
    id: 'galen_green',
    name: 'Galen Green',
    textureKey: 'skin-galen-green',
    color: 0x365e8d,
    hex: '#365E8D',
    secret: true,
  },
  {
    id: 'cara_lill',
    name: 'Cara Lill',
    textureKey: 'skin-cara-lill',
    color: 0xa8344a,
    hex: '#A8344A',
    secret: true,
  },
  {
    id: 'oliver_heffernan',
    name: 'Oliver Heffernan',
    textureKey: 'skin-oliver-heffernan',
    color: 0x78a84b,
    hex: '#78A84B',
    secret: true,
  },
];

export const DEFAULT_PLAYER_SKIN_ID = publicSkins[0].id;

const skinAccessByCallsign = new Map<string, Set<string>>();
const SKIN_ACCESS_STORAGE_KEY = 'the-last-light-skin-access';

loadCachedSkinAccess();

export function setPlayerSkinAccess(callsign: string, skinIds: readonly string[]): void {
  const key = callsign.trim().toLocaleLowerCase();
  if (!key) return;
  skinAccessByCallsign.set(key, new Set(skinIds.filter((id) => (
    (SECRET_PLAYER_SKIN_IDS as readonly string[]).includes(id)
  ))));
  persistSkinAccess();
}

export function getPlayerSkinAccessIds(callsign: string): string[] {
  const access = skinAccessByCallsign.get(callsign.trim().toLocaleLowerCase());
  return secretSkins
    .filter((skin) => access?.has(skin.id))
    .map((skin) => skin.id);
}

export function getAvailablePlayerSkins(callsign: string): PlayerSkin[] {
  const accessibleSkinIds = new Set(getPlayerSkinAccessIds(callsign));
  const matchedSecrets = secretSkins.filter((skin) => accessibleSkinIds.has(skin.id));
  return [...publicSkins, ...matchedSecrets];
}

export function getDefaultPlayerSkin(callsign: string): PlayerSkin {
  const accessibleSkinIds = new Set(getPlayerSkinAccessIds(callsign));
  const matchedSecret = secretSkins.find((skin) => accessibleSkinIds.has(skin.id));
  return matchedSecret ?? publicSkins[0];
}

export function getPlayerSkin(id: string | undefined, callsign: string): PlayerSkin {
  const available = getAvailablePlayerSkins(callsign);
  return available.find((skin) => skin.id === id) ?? getDefaultPlayerSkin(callsign);
}

export function getPlayerSkinPreviewUrl(skin: Pick<PlayerSkin, 'id'>): string {
  return skinPreviewUrls[skin.id] ?? skinPreviewUrls[DEFAULT_PLAYER_SKIN_ID];
}

let playerSkinPreviewPreload: Promise<void> | undefined;

export function preloadPlayerSkinPreviews(): Promise<void> {
  if (playerSkinPreviewPreload) return playerSkinPreviewPreload;
  playerSkinPreviewPreload = Promise.all(Object.values(skinPreviewUrls).map((url) => new Promise<void>((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve();
    image.onerror = () => resolve();
    image.src = url;
  }))).then(() => undefined);
  return playerSkinPreviewPreload;
}

function loadCachedSkinAccess(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SKIN_ACCESS_STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [callsign, skinIds] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(skinIds)) continue;
      const knownSkinIds = skinIds.filter((id): id is string => (
        typeof id === 'string'
        && (SECRET_PLAYER_SKIN_IDS as readonly string[]).includes(id)
      ));
      skinAccessByCallsign.set(callsign, new Set(knownSkinIds));
    }
  } catch {
    localStorage.removeItem(SKIN_ACCESS_STORAGE_KEY);
  }
}

function persistSkinAccess(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const entries = [...skinAccessByCallsign.entries()].slice(-64).map(([callsign, skinIds]) => (
      [callsign, [...skinIds]]
    ));
    localStorage.setItem(SKIN_ACCESS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // The server remains authoritative if browser storage is unavailable.
  }
}
