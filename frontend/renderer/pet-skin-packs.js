'use strict';

/**
 * R56 (2026-09-24) — meme skin packs (cat + whale) extracted from pet.js.
 *
 * The whale (鲸鱼女仆) skin is the upstream main(v1.2.0) dsh-companion skin.
 * cat and whale are structurally isomorphic: both render through the SAME
 * #cat DOM node and the same `update()` branch; every per-pack difference
 * (state→GIF table, pose pools, asset directory) lives in MEME_PACKS.
 *
 * pet.js keeps thin wrappers (`isMeme()` / `updateCat(s)` / preloading) so
 * call sites are unchanged; this module owns the tables, the lazy asset
 * cache, the dir-aware "already loaded" comparison, and the pose rotation.
 *
 * Asset sizes: cat ≈2.6MB, whale ≈21MB — both lazy-load ONLY when their skin
 * is selected (R30 discipline; whale at startup would be unacceptable).
 */
window.OctoPetSkinPacks = (() => {
  const CAT_STATES = {
    idle: 'cat-idle.gif',           // 转椅上冰淇淋+手机摸鱼：待命
    roam: 'cat-roam.gif',           // 撒腿跑着玩：闲逛
    working: 'cat-working.gif',     // 戴耳机猛拍「上号」按钮：干活
    thinking: 'cat-thinking.gif',   // 对着笔记本挠头：思考
    talking: 'cat-talking.gif',     // 对着笔记本疯狂输出喵喵喵：回应中
    juggling: 'cat-juggling.gif',   // 趴键盘上还同时刷手机：并行子任务
    sweeping: 'cat-sweeping.gif',   // 喷消毒水打扫：压缩/清理
    waiting: 'cat-waiting.gif',     // 冒汗紧张等待：等你授权
    needsinput: 'cat-needsinput.gif', // 头顶冒问号挠头：等你回复
    happy: 'cat-happy.gif',         // 摸小猫的头夸夸：完成庆祝
    greet: 'cat-greet.gif',         // 被闹钟炸醒弹射到工位：新会话火速上线
    attention: 'cat-attention.gif', // 从工位起身够手机看消息：需要注意
    sleeping: 'cat-sleeping.gif',   // 被窝里睡成一坨：睡觉
    error: 'cat-error.gif',         // 抱头崩溃大叫：出错
    loafing: 'cat-loafing.gif',     // 躺地上刷手机：上一步干完、等下一步的间隙摸鱼
    // 情绪短暂态 → 就近映射，别回落到摸鱼 idle 图（表情和文案会打架）
    loved: 'cat-happy.gif',         // 被夸 → 摸头开心
    excited: 'cat-happy.gif',
    sad: 'cat-sad.gif',             // 惹你生气了 → 嚎啕大哭
    sorry: 'cat-waiting.gif',       // 道歉 → 冒冷汗心虚
    puzzled: 'cat-needsinput.gif',  // 疑惑 → 头顶问号
  };
  // working/thinking stay longest → multi-pose rotation every 60s (avoids "stuck" look).
  const CAT_POOLS = {
    working: [
      'cat-working.gif',   // 猛拍「上号」按钮
      'cat-working-2.gif', // 熬夜冠军：戴耳机对着显示器
      'cat-working-3.gif', // 捂着耳朵埋头猛敲键盘
      'cat-working-4.gif', // 边吃零食边敲键盘
    ],
    thinking: [
      'cat-thinking.gif',   // 对着笔记本挠头
      'cat-thinking-2.gif', // 躺着想：头顶「浮云」思考泡
    ],
    sleeping: [
      'cat-sleeping.gif',   // 被窝里睡成一坨
      'cat-sleeping-2.gif', // 坐椅子上拔下肚子毛当眼罩睡
    ],
    loafing: [
      'cat-loafing.gif',   // 躺地上刷手机
      'cat-loafing-2.gif', // 沙发上点外卖
      'cat-loafing-3.gif', // 靠着枕头奶瓶+手机
    ],
  };
  // 鲸鱼女仆（whale）：自有原创角色，图生视频产出，每状态一张 360px GIF，
  // 180px 呈现（Retina 用真实 2x 源）。见 assets/whale/CREDITS.md。
  const WHALE_STATES = {
    idle: 'whale-idle.gif',             // 转椅上饮料+手机：待命
    working: 'whale-working.gif',       // 桌前对着笔记本：干活
    thinking: 'whale-thinking.gif',     // 按着太阳穴+压力符号：思考
    talking: 'whale-talking.gif',       // 戴耳机对着笔记本输出：回应中
    juggling: 'whale-juggling.gif',     // 趴键盘上还刷手机：并行子任务
    sweeping: 'whale-sweeping.gif',     // 喷消毒水：压缩/清理
    waiting: 'whale-waiting.gif',       // 冒汗紧张特写：等你授权
    needsinput: 'whale-needsinput.gif', // 头顶问号挠头：等你回复
    attention: 'whale-attention.gif',   // 从工位够手机：需要注意
    error: 'whale-error.gif',           // 抱头崩溃大叫：出错
    sad: 'whale-sad.gif',               // 嚎啕大哭：负面情绪
    loafing: 'whale-loafing.gif',       // 躺着刷手机：间隙摸鱼
    sorry: 'whale-waiting.gif',         // 道歉 → 冒冷汗心虚
    puzzled: 'whale-needsinput.gif',    // 疑惑 → 头顶问号
    happy: 'whale-happy.gif',           // 摸鲸鱼玩偶的头夸夸：完成庆祝
    loved: 'whale-happy.gif',           // 被夸 → 摸头开心
    excited: 'whale-happy.gif',
    roam: 'whale-roam.gif',             // 原地小跑：闲逛
    sleeping: 'whale-sleeping.gif',     // 被窝鼓包随呼吸起伏：睡觉
    greet: 'whale-greet.gif',           // 飞向工位：新会话火速上线
  };
  // 与 cat 同构的姿态轮换。thinking 池里的 whale-working-3.gif 是「桌前对着
  // 笔记本」——上游按需求把 thinking 与 working-3 的画面对调过，故它在池中
  // 而不在 thinking 主图位。
  const WHALE_POOLS = {
    working: [
      'whale-working.gif',   // 戴耳机猛拍「上号」按钮
      'whale-working-2.gif', // 熬夜冠军：戴耳机对着显示器
      'whale-working-3.gif', // 桌前对着笔记本
      'whale-working-4.gif', // 边吃零食边敲键盘
    ],
    sleeping: [
      'whale-sleeping.gif',   // 被窝鼓包随呼吸起伏
      'whale-sleeping-2.gif', // 坐椅子上闭眼睡
    ],
    loafing: [
      'whale-loafing.gif',   // 躺着刷手机
      'whale-loafing-2.gif', // 懒人沙发上点外卖
      'whale-loafing-3.gif', // 靠着沙发奶瓶+手机
    ],
  };
  // meme 类皮肤共用一条渲染分支，彼此的差别全部收在这张表里。
  const MEME_PACKS = {
    cat: { dir: 'cat', states: CAT_STATES, pools: CAT_POOLS },
    whale: { dir: 'whale', states: WHALE_STATES, pools: WHALE_POOLS },
  };
  const ASSET_FILES = {};
  const ASSET_CACHES = {};
  for (const name of Object.keys(MEME_PACKS)) {
    ASSET_FILES[name] = Array.from(new Set([
      ...Object.values(MEME_PACKS[name].states),
      ...Object.values(MEME_PACKS[name].pools).flat(),
    ]));
    ASSET_CACHES[name] = new Map();
  }

  // Injected by pet.js: the #cat-img element and pet.js's fadeSwapImg.
  let catImg = null;
  let fadeSwap = null;

  const isMeme = (skin) => Object.prototype.hasOwnProperty.call(MEME_PACKS, skin);
  const packOf = (skin) => (isMeme(skin) ? MEME_PACKS[skin] : MEME_PACKS.cat);

  function ensurePreloaded(skin) {
    const cache = ASSET_CACHES[skin];
    if (!cache || cache.size > 0) return;
    for (const file of ASSET_FILES[skin]) {
      const image = new Image();
      image.decoding = 'async';
      image.src = `../assets/${skin}/${file}`;
      cache.set(file, image);
    }
  }

  // 比对含目录的尾巴，而不是裸文件名：cat/whale 同名规则下两套皮肤不会
  // 互相误判为「已加载」（上游 main pet.js:223 同款防御）。
  function assetMatches(filename) {
    if (!catImg) return false;
    try {
      return new URL(catImg.src, window.location.href).pathname.endsWith('/' + filename);
    } catch {
      return String(catImg.getAttribute('src') || '').split(/[?#]/, 1)[0].endsWith(filename);
    }
  }

  const POOL_ROTATE_MS = 60 * 1000;
  let poolIdx = 0;
  let poolRot = null;
  // The rotation timer reads the live skin/state; pet.js reports both on
  // every update() so the timer stays correct without module-internal DOM.
  let currentSkin = 'mascot';
  let currentState = 'idle';

  function update(skin, state) {
    if (!catImg) return;
    currentSkin = skin;
    currentState = state;
    if (!isMeme(skin)) {
      // Leaving meme skins (mascot/pixel render themselves) — stop the
      // pose-rotation timer so it doesn't fire against a stale skin.
      if (poolRot) { clearInterval(poolRot); poolRot = null; }
      return;
    }
    const { dir, states, pools } = packOf(skin);
    const pool = pools[state];
    const f = pool ? pool[poolIdx % pool.length] : (states[state] || states.idle);
    if (!assetMatches(dir + '/' + f)) fadeSwap(catImg, `../assets/${dir}/${f}`);
    if (pool) {
      if (!poolRot) {
        poolRot = setInterval(() => {
          if (!isMeme(currentSkin)) return;
          const pack = packOf(currentSkin);
          const cur = pack.pools[currentState];
          if (!cur || !catImg || !fadeSwap) return;
          poolIdx++;
          fadeSwap(catImg, `../assets/${pack.dir}/${cur[poolIdx % cur.length]}`);
        }, POOL_ROTATE_MS);
      }
    } else if (poolRot) {
      clearInterval(poolRot);
      poolRot = null;
      poolIdx++; // 下次进入轮换态直接是下一张
    }
  }

  function configure({ img, swap }) {
    catImg = img || catImg;
    fadeSwap = swap || fadeSwap;
  }

  return { MEME_PACKS, isMeme, packOf, ensurePreloaded, update, configure, assetMatches };
})();
