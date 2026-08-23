const stage = document.getElementById('stage');
const pixel = document.getElementById('pixel');
const mascot = document.getElementById('mascot');
const mascotImg = document.getElementById('mascot-img');
const cat = document.getElementById('cat');

// 图标款按状态换眼神（每种状态一张只改眼睛的图）
const MASCOT_EYES = {
  working: 'mascot-work.png', // 干活：对着笔记本敲代码 + 咖啡（整幅工作场景）
  roam: 'mascot.png',        // 旅行：使用完整站姿，容器负责走路动画
  juggling: 'mascot-work.png', // 并行子任务：无独立图，回落到干活
  sweeping: 'mascot-work.png', // 清理上下文：无独立图，回落到干活
  loafing: 'mascot-sleep.png', // 间隙摸鱼：无独立图，回落到闭眼待机
  idle: 'mascot-sleep.png',   // 无任务：闭眼
  sleeping: 'mascot-sleep.png',
  thinking: 'mascot-think.png', // 思考：往上看
  happy: 'mascot-happy.png',  // 完成：^^ 笑眼
  greet: 'mascot-happy.png',
  talking: 'mascot-happy.png',
  waiting: 'mascot-wait.png', // 等你处理：瞪大
  needsinput: 'mascot-think.png', // 等你回复：往上看(期待)
  error: 'mascot-wait.png',
  // 情绪短暂态 → 就近回落（专属图未画）
  loved: 'mascot-happy.png',
  excited: 'mascot-happy.png',
  sad: 'mascot-wait.png',
  sorry: 'mascot-wait.png',
  puzzled: 'mascot-think.png',
};
function updateMascotEyes(s) {
  if (!mascotImg) return;
  const f = MASCOT_EYES[s] || 'mascot.png';
  if (!mascotImg.getAttribute('src').endsWith(f)) mascotImg.src = '../assets/' + f;
}

// 月薪喵（cat）：每个状态一张 meme GIF（原作者：抖音 @月薪喵）
const catImg = document.getElementById('cat-img');
const CAT_STATES = {
  idle: 'cat-idle.gif',           // 转椅上冰淇淋+手机摸鱼：待命
  roam: 'cat-roam.gif',           // 撒腿跑着玩：闲逛
  working: 'cat-working.gif',     // 戴耳机猛拍「上号」按钮：干活
  thinking: 'cat-thinking.gif',   // 对着笔记本挠头：思考
  lookout: 'cat-thinking-2.gif',  // 趴着望向浮云：掠夺后朝远处看战果
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
// working/thinking 是停留最久的两个状态 → 多张姿态轮换：进入时换下一张，
// 持续期间每 60s 也换一张。大上下文会话推理一次要几分钟，单张静止图
// 播几分钟观感像卡死，轮换让「还活着」看得见。
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

// 鲸鱼女仆（whale）：自有角色，图生视频产出，每状态一张 GIF。
// 结构与 cat 完全同构（120px、逐帧真透明、一状态一图），因此两者共用同一条
// 渲染分支和同一个 DOM 节点，差别只在目录和文件名表。见 assets/whale/CREDITS.md。
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
  // ↓ 以下状态尚无专属画面，先借语义最近的顶上；有专属图后只改这几行即可。
  happy: 'whale-idle.gif',            // 占位：完成庆祝 → 转椅上惬意
  loved: 'whale-idle.gif',            // 占位
  excited: 'whale-idle.gif',          // 占位
  roam: 'whale-idle.gif',             // 占位：闲逛 → 待命
  lookout: 'whale-loafing.gif',       // 占位：趴着望远处 → 躺着刷手机
  sleeping: 'whale-loafing.gif',      // 占位：睡觉 → 躺着，最接近休息
  greet: 'whale-attention.gif',       // 占位：新会话上线 → 从工位起身
};
// whale 每个状态只有一张图，没有可轮换的姿态，故不设 pool。
const WHALE_POOLS = {};

// meme 类皮肤共用一条渲染分支，彼此的差别全部收在这张表里。
const MEME_PACKS = {
  cat: { dir: 'cat', states: CAT_STATES, pools: CAT_POOLS },
  whale: { dir: 'whale', states: WHALE_STATES, pools: WHALE_POOLS },
};
const isMeme = () => Object.prototype.hasOwnProperty.call(MEME_PACKS, skin);
const memePack = () => MEME_PACKS[skin] || MEME_PACKS.cat;

const POOL_ROTATE_MS = 60 * 1000;
let poolIdx = 0;
let poolRot = null;
function updateCat(s) {
  if (!catImg) return;
  const { dir, states, pools } = memePack();
  const pool = pools[s];
  const f = (pool ? pool[poolIdx % pool.length] : (states[s] || states.idle));
  if (!catAssetMatches(dir + '/' + f)) catImg.src = '../assets/' + dir + '/' + f;
  if (pool) {
    if (!poolRot) {
      poolRot = setInterval(() => {
        if (!isMeme()) return;
        const p = memePack();
        const cur = p.pools[state];
        if (!cur) return;
        poolIdx++;
        catImg.src = '../assets/' + p.dir + '/' + cur[poolIdx % cur.length];
      }, POOL_ROTATE_MS);
    }
  } else if (poolRot) {
    clearInterval(poolRot);
    poolRot = null;
    poolIdx++; // 下次进入轮换态直接是下一张
  }
}
// 比对含目录的尾巴，而不是裸文件名：两套皮肤同名文件不会互相误判为"已加载"。
function catAssetMatches(filename) {
  if (!catImg) return false;
  try {
    return new URL(catImg.src, window.location.href).pathname.endsWith('/' + filename);
  } catch {
    return String(catImg.getAttribute('src') || '').split(/[?#]/, 1)[0].endsWith(filename);
  }
}
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const chipCost = document.getElementById('chip-cost');
const chipWindow = document.getElementById('chip-window');
const chipSep = document.getElementById('chip-sep');
const chip = document.getElementById('chip');
const sessionsEl = document.getElementById('sessions');
const radial = document.getElementById('radial');
const thinkEl = document.getElementById('think');
const sleepEl = document.getElementById('sleep');
const propEl = document.getElementById('prop');
const sidekickEl = document.getElementById('sidekick');
const askEl = document.getElementById('ask');
const askScroll = document.getElementById('ask-scroll');
const askLabel = document.getElementById('ask-label');
const askSess = document.getElementById('ask-sess');
const askQhead = document.getElementById('ask-qhead');
const askQ = document.getElementById('ask-q');
const askHint = document.getElementById('ask-hint');
const askOpts = document.getElementById('ask-opts');
const askInputRow = document.getElementById('ask-input-row'); // .ask-other
const askText = document.getElementById('ask-text');
const askPage = document.getElementById('ask-page');
const askFoot = document.getElementById('ask-foot');
const askSubmit = document.getElementById('ask-submit');
const askBack = document.getElementById('ask-back');
const askTerm = document.getElementById('ask-term');
const notepad = document.getElementById('notepad');
const npBadge = document.getElementById('np-badge');
const todopop = document.getElementById('todopop');
const tpProg = document.getElementById('tp-prog');
const tpList = document.getElementById('tp-list');
const tpActs = document.getElementById('tp-acts');
const tpActSec = document.getElementById('tp-act-sec');
const tpTodoSec = document.getElementById('tp-todo-sec');
const sesslist = document.getElementById('sesslist');
const slRows = document.getElementById('sl-rows');
const slSub = document.getElementById('sl-sub');
const slTitle = document.getElementById('sl-title');
const slBack = document.getElementById('sl-back');
const slSessionView = document.getElementById('sl-session-view');
const slTakeoverView = document.getElementById('sl-takeover-view');
const slTakeoverSession = document.getElementById('sl-takeover-session');
const slTakeoverClaude = document.getElementById('sl-takeover-claude');
const slTakeoverCodex = document.getElementById('sl-takeover-codex');
const slTakeoverClaudeMode = document.getElementById('sl-takeover-claude-mode');
const slTakeoverCodexMode = document.getElementById('sl-takeover-codex-mode');
const slTakeoverStatus = document.getElementById('sl-takeover-status');
const slSearch = document.getElementById('sl-search');
const slFilters = document.getElementById('sl-filters');
const slArchivedToggle = document.getElementById('sl-archived-toggle');

