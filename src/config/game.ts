import Phaser from 'phaser';
import { ArenaScene } from '../scenes/ArenaScene';
import { GAME_HEIGHT, GAME_WIDTH } from './constants';

export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#171c18',
  pixelArt: true,
  roundPixels: true,
  input: {
    activePointers: 2,
  },
  physics: {
    default: 'arcade',
    arcade: {
      // Include the debug renderer only in development. Scenes leave it off by default.
      debug: import.meta.env.DEV,
      ...(import.meta.env.DEV ? {
        debugShowBody: true,
        debugShowStaticBody: true,
        debugShowVelocity: false,
        debugBodyColor: 0x5dffad,
        debugStaticBodyColor: 0xff6b5d,
      } : {}),
    },
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    expandParent: true,
  },
  render: {
    antialias: false,
    pixelArt: true,
    roundPixels: true,
  },
  scene: ArenaScene,
};
