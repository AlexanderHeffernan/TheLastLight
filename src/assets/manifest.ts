import Phaser from 'phaser';
import soldierUrl from './characters/soldier.png';
import topdownSoldierSkinUrl from './characters/skins/topdown_soldier_64.png';
import fieldMedicSkinUrl from './characters/skins/field_medic_64.png';
import mechanicSkinUrl from './characters/skins/mechanic_64.png';
import homesteaderSkinUrl from './characters/skins/homesteader_64.png';
import apartmentSurvivorSkinUrl from './characters/skins/apartment_survivor_64.png';
import hunterSkinUrl from './characters/skins/hunter_64.png';
import urbanClimberSkinUrl from './characters/skins/urban_climber_64.png';
import blockGuardianSkinUrl from './characters/skins/block_guardian_64.png';
import courierSkinUrl from './characters/skins/courier_64.png';
import alexanderHeffernanSkinUrl from './characters/skins/alexander_heffernan_64.png';
import galenGreenSkinUrl from './characters/skins/galen_green_64.png';
import caraLillSkinUrl from './characters/skins/cara_lill_64.png';
import oliverHeffernanSkinUrl from './characters/skins/oliver_heffernan_64.png';
import zombieUrl from './characters/zombie.png';
import zombieRunnerUrl from './enemies/zombie_runner_64.png';
import zombieBruteUrl from './enemies/zombie_brute_64.png';
import zombieCharredUrl from './enemies/zombie_charred_64.png';
import zombieCrawlerUrl from './enemies/zombie_crawler_64.png';
import zombieBreakerUrl from './enemies/zombie_breaker_96.png';
import zombieLurkerUrl from './enemies/zombie_lurker_96.png';
import zombieFurnaceUrl from './enemies/zombie_furnace_96.png';
import zombieSpitterUrl from './enemies/zombie_spitter_96.png';
import groundAUrl from './ground/wasteland-a.png';
import groundBUrl from './ground/wasteland-b.png';
import groundCUrl from './ground/wasteland-c.png';
import groundDUrl from './ground/wasteland-d.png';
import barrelUrl from './props/explosive_barrel_64.png';
import generatorUrl from './props/field_generator_64.png';
import floodlightUrl from './props/floodlight_64.png';
import sandbagsUrl from './props/sandbag_barricade_64.png';
import treeTrunkUrl from './props/dead_tree_trunk_64.png';
import treeCanopyUrl from './props/dead_tree_canopy_128.png';
import explosionUrl from './effects/barrel_explosion_64_sheet.png';
import bulletImpactUrl from './effects/bullet_impact_32_sheet.png';
import bloodHitUrl from './effects/blood_hit_32_sheet.png';
import groundFireUrl from './effects/ground_fire_64_sheet.png';
import supplyCacheClosedUrl from './supplies/supply_cache_closed_64.png';
import supplyCacheOpenUrl from './supplies/supply_cache_open_64.png';
import medkitUrl from './supplies/medkit_pickup_64.png';
import adrenalineUrl from './supplies/adrenaline_pickup_64.png';
import repairKitUrl from './supplies/field_repair_kit_64.png';
import flareCartridgeUrl from './supplies/flare_cartridge_64.png';
import ashesAtDawnUrl from './audio/ashes-at-dawn.mp3';
import lastBarricadeUrl from './audio/Last Barricade.mp3';
import lastBarricadeAlternateUrl from './audio/Last Barricade-2.mp3';
import breakerThemeUrl from './audio/THE BREAKER.mp3';
import furnaceThemeUrl from './audio/THE FURNACE.mp3';
import lurkerThemeUrl from './audio/THE LURKER.mp3';
import spitterThemeUrl from './audio/THE SPITTER.mp3';
import defeatThemeUrl from './audio/Ashes Keep Moving.mp3';
import defeatThemeAlternateUrl from './audio/Ashes Keep Moving-2.mp3';

const musicTracks = [
  ['music-ashes-at-dawn', ashesAtDawnUrl],
  ['music-last-barricade', lastBarricadeUrl],
  ['music-last-barricade-alternate', lastBarricadeAlternateUrl],
] as const;

export const MUSIC_KEYS = musicTracks.map(([key]) => key);

export const BOSS_MUSIC_KEYS = {
  breaker: 'music-boss-breaker',
  lurker: 'music-boss-lurker',
  furnace: 'music-boss-furnace',
  spitter: 'music-boss-spitter',
} as const;

const bossMusicTracks = [
  [BOSS_MUSIC_KEYS.breaker, breakerThemeUrl],
  [BOSS_MUSIC_KEYS.lurker, lurkerThemeUrl],
  [BOSS_MUSIC_KEYS.furnace, furnaceThemeUrl],
  [BOSS_MUSIC_KEYS.spitter, spitterThemeUrl],
] as const;

const defeatMusicTracks = [
  ['music-defeat-ashes-keep-moving', defeatThemeUrl],
  ['music-defeat-ashes-keep-moving-alternate', defeatThemeAlternateUrl],
] as const;

export const DEFEAT_MUSIC_KEYS = defeatMusicTracks.map(([key]) => key);

export function loadAssets(scene: Phaser.Scene): void {
  scene.load.image('soldier', soldierUrl);
  scene.load.image('skin-topdown-soldier', topdownSoldierSkinUrl);
  scene.load.image('skin-field-medic', fieldMedicSkinUrl);
  scene.load.image('skin-mechanic', mechanicSkinUrl);
  scene.load.image('skin-homesteader', homesteaderSkinUrl);
  scene.load.image('skin-apartment-survivor', apartmentSurvivorSkinUrl);
  scene.load.image('skin-hunter', hunterSkinUrl);
  scene.load.image('skin-urban-climber', urbanClimberSkinUrl);
  scene.load.image('skin-block-guardian', blockGuardianSkinUrl);
  scene.load.image('skin-courier', courierSkinUrl);
  scene.load.image('skin-alexander-heffernan', alexanderHeffernanSkinUrl);
  scene.load.image('skin-galen-green', galenGreenSkinUrl);
  scene.load.image('skin-cara-lill', caraLillSkinUrl);
  scene.load.image('skin-oliver-heffernan', oliverHeffernanSkinUrl);
  scene.load.image('zombie', zombieUrl);
  scene.load.image('zombie-runner', zombieRunnerUrl);
  scene.load.image('zombie-brute', zombieBruteUrl);
  scene.load.image('zombie-charred', zombieCharredUrl);
  scene.load.image('zombie-crawler', zombieCrawlerUrl);
  scene.load.image('zombie-breaker', zombieBreakerUrl);
  scene.load.image('zombie-lurker', zombieLurkerUrl);
  scene.load.image('zombie-furnace', zombieFurnaceUrl);
  scene.load.image('zombie-spitter', zombieSpitterUrl);
  scene.load.image('ground-a', groundAUrl);
  scene.load.image('ground-b', groundBUrl);
  scene.load.image('ground-c', groundCUrl);
  scene.load.image('ground-d', groundDUrl);
  scene.load.image('barrel', barrelUrl);
  scene.load.image('generator', generatorUrl);
  scene.load.image('floodlight', floodlightUrl);
  scene.load.image('sandbags', sandbagsUrl);
  scene.load.image('tree-trunk', treeTrunkUrl);
  scene.load.image('tree-canopy', treeCanopyUrl);
  scene.load.image('supply-cache-closed', supplyCacheClosedUrl);
  scene.load.image('supply-cache-open', supplyCacheOpenUrl);
  scene.load.image('medkit', medkitUrl);
  scene.load.image('adrenaline', adrenalineUrl);
  scene.load.image('repair-kit', repairKitUrl);
  scene.load.image('flare-cartridge', flareCartridgeUrl);
  scene.load.spritesheet('explosion', explosionUrl, { frameWidth: 64, frameHeight: 64 });
  scene.load.spritesheet('bullet-impact', bulletImpactUrl, { frameWidth: 32, frameHeight: 32 });
  scene.load.spritesheet('blood-hit', bloodHitUrl, { frameWidth: 32, frameHeight: 32 });
  scene.load.spritesheet('ground-fire', groundFireUrl, { frameWidth: 64, frameHeight: 64 });
  musicTracks.forEach(([key, url]) => scene.load.audio(key, url));
  bossMusicTracks.forEach(([key, url]) => scene.load.audio(key, url));
  defeatMusicTracks.forEach(([key, url]) => scene.load.audio(key, url));
}
