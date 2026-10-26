// 与 docs/backend-api.md / chaincode-api.md 对齐的共享类型

export type Role = 'player' | 'admin' | 'arbitrator';

export interface User {
  id: string;
  username: string;
  nickname: string;
  role: Role;
  avatarUri?: string;
  level?: number;
  points?: number;
  wins?: number;
  losses?: number;
  /** 注册时间（GET /users/me 的 createdAt；链上 Player.createdAt 的落库副本） */
  createdAt?: string;
  /** 是否已领新手御三家（GET /users/me；undefined = 未知，不触发 /starter 引导） */
  hasStarter?: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface IVs {
  hp: number;
  atk: number;
  def: number;
  spatk: number;
  spdef: number;
  speed: number;
}

/** 努力值 EV（单项 0-255、总和 ≤510），与 IV 同形 */
export type EVs = IVs;

/** 六项最终能力值（后端 computeStats 计算，链上不存） */
export type Stats = IVs;

export type PokemonStatus = 'IDLE' | 'LOCKED_TRADE' | 'LOCKED_BATTLE' | 'RELEASED';

/** 一条进化分支（后端 evolution/evolutions，条件来自 game-data EVOLUTIONS，docs/backend-api.md §2） */
export interface EvolutionStep {
  fromSpeciesId: number;
  targetSpeciesId: number;
  /** 目标种族英文名（与 Pokemon.name 同口径） */
  targetName: string;
  /** 目标种族中文名 */
  targetNameZh: string;
  /** 等级条件（石头进化同样要求这个等级） */
  minLevel: number;
  /** 有值 = 需要对应进化石（雷之石 / 水之石 / 火之石） */
  stoneTypeId?: string;
  /** 等级条件是否已满足 */
  levelOk: boolean;
  /** 现在就能进化（纯等级进化且等级达标） */
  canEvolveNow: boolean;
}

export interface Pokemon {
  id: string;
  speciesId: number;
  name: string;
  dnaHash: string;
  ivs: IVs;
  /** 旧链上记录可能缺失该字段，读作全 0 */
  evs?: EVs;
  /** 详情接口附带：种族值 + IV + EV + 等级 + 性格修正后的最终能力值 */
  stats?: Stats;
  nature: string;
  ability: string;
  shiny: boolean;
  level: number;
  exp: number;
  moves: string[];
  ownerId: string;
  status: PokemonStatus;
  lockRef?: string;
  captureEventId?: string;
  createdAt?: string;
  /** 羁绊值 0-255：铸造 50、易主（交易/对战被赢走）重置 30、PvP 参战 +2/+1（每日每宠上限 +6） */
  bond?: number;
  /**
   * 当前 HP（链下 Redis，缺键 = 满血；上限为 `stats.hp`）。
   * 跨战斗持久：伤药/宝可梦中心是唯一的恢复途径（docs/backend-api.md §2「伤势持久化」）。
   */
  currentHp?: number;
  /** 是否濒死（currentHp = 0）：不能出战/进队伍，需治疗 */
  fainted?: boolean;
  // --- [FEAT:breeding] begin ---
  /** 双亲 id（仅繁殖产生的子代有，链上可选字段） */
  parents?: string[];
  /** 代数：野生/铸造为 0 或缺省，子代为 max(父,母)+1 */
  generation?: number;
  // --- [FEAT:breeding] end ---
  /**
   * 改名次数（0/缺省 = 从未改名）：第一次免费，之后每次 50P（docs/backend-api.md §2「改名」）。
   * 详情/列表接口附带，改名对话框据此显示「首次免费 / 本次 50P」。
   */
  renameCount?: number;
  /**
   * 羁绊战斗加成百分比（详情/列表附带，两位小数）：非 HP 五项在战斗中 × (1 + bond/255 × 5%)，
   * 满羁绊 5%、128 约 2.51%（docs/backend-api.md §2「羁绊加成」/§11）；`stats` 仍是不含羁绊的基础值。
   */
  bondBonus?: number;
  /** 默认展示的进化分支（无进化为 null） */
  evolution?: EvolutionStep | null;
  /** 全部进化分支（伊布 5 条线都在内，"可以进化"的排在最前） */
  evolutions?: EvolutionStep[];
}

export interface Item {
  id: string;
  typeId: string;
  ownerId: string;
  quantity: number;
  uri?: string;
  metadataHash?: string;
  status: 'IDLE' | 'LOCKED_TRADE' | 'LOCKED_BATTLE';
  lockRef?: string;
  /** 铸造/拆分时间（链上 ItemState.createdAt，堆叠合并按它判定最早堆叠） */
  createdAt?: string;
}

export interface PokedexEntry {
  speciesId: number;
  name: string;
  types: string[];
  baseRate?: number;
  owned: number;
  /** 永久解锁（捕获/领取/进化过即 true；进化后低阶种族仍算已捕获） */
  unlocked?: boolean;
  /** 该种族的进化分支（后端 /pokedex 附带，图鉴详情展示进化链与条件） */
  evolutions?: EvolutionStep[];
}

export interface WildEncounter {
  eventId: string;
  wild: {
    speciesId: number;
    name: string;
    nameZh?: string;
    level: number;
    previewSpriteUri?: string;
    /** 官方种族捕获率（3–255），保留给审计/调试；成功率以服务端 captureChances 为准 */
    catchRate?: number;
  };
  /** 快速捕捉（无队伍降级路径）的球成功率：服务端按满血投球算好，前端不再复算公式 */
  captureChances?: WildBallOption[];
  commitHash: string;
  clientSeed?: string;
}

export interface CaptureResult {
  success: boolean;
  shakes: number;
  pokemon?: Pokemon;
}

/**
 * `GET /capture/zones` 的区域表条目（docs/backend-api.md §2「区域与栖息地野生池」）。
 * 等级带/阶段门槛/栖息地/传说门控的唯一事实来源是后端 `game-data/encounter.data.ts`；
 * 前端不再镜像整张表，只在启动时拉取一次（`stores/zone.ts::loadZones`）。
 */
export interface CaptureZoneInfo {
  id: string;
  /** 中文展示名（HUD / CaptureOverlay / 图鉴「出现区域」） */
  name: string;
  minLevel: number;
  maxLevel: number;
  /** 进化阶段门槛（`stage ≤ maxStage`）；传说区池显式指定，门槛不参与过滤 */
  maxStage: number;
  /** 栖息地属性集（传说区为 []） */
  habitats: string[];
  legendary: boolean;
  /** 进入该区所需的钥匙 typeId（普通区为 null） */
  keyTypeId: string | null;
  /** 钥匙中文名（与 keyTypeId 同源） */
  keyNameZh: string | null;
  /** 是否允许付费诱饵（传说区 false，后端会拒 `LURE_NOT_ALLOWED`） */
  lureAllowed: boolean;
  /** 该区加权野生池的种族数 */
  poolSize: number;
}

/** `GET /capture/zones` 响应：缺省区 + 旧三区别名 + 13 个区（前端另有 town 安全区伪区域） */
export interface CaptureZonesResponse {
  default: string;
  aliases: Record<string, string>;
  zones: CaptureZoneInfo[];
}

/** PvE 野怪战斗（docs/backend-api.md §2：POST /wild/start → POST /wild/:id/action） */
export type WildStatus =
  | 'ACTIVE'
  | 'CAUGHT'
  | 'WILD_FAINTED'
  | 'PLAYER_FAINTED'
  | 'RAN'
  | 'TIMEOUT';

export interface WildBattleEvent {
  kind:
    | 'encounter'
    | 'move'
    | 'miss'
    | 'damage'
    | 'faint'
    | 'ball'
    | 'ball-failed'
    | 'caught'
    | 'run'
    | 'timeout'
    | 'end';
  side?: 'player' | 'wild';
  detail: Record<string, unknown>;
}

export interface WildTurnLog {
  turn: number;
  events: WildBattleEvent[];
}

export interface WildMoveOption {
  id: string;
  name: string;
  type: string;
  power: number;
  accuracy: number;
  category: 'physical' | 'special';
}

/** 背包里的球 + 该球当前的捕捉成功率（随野怪 HP 实时变化） */
export interface WildBallOption {
  itemId: string;
  typeId: string;
  name: string;
  nameZh: string;
  quantity: number;
  ballBonus: number;
  chance: number;
}

export interface WildState {
  sessionId: string;
  eventId: string;
  turn: number;
  status: WildStatus;
  finished: boolean;
  attempts: number;
  expiresAt: number;
  expGained: number;
  wild: {
    speciesId: number;
    name: string;
    nameZh: string;
    type: string;
    level: number;
    shiny: boolean;
    hp: number;
    maxHp: number;
    moves: string[];
    catchRate: number;
  };
  mine: {
    pokemonId: string;
    speciesId: number;
    name: string;
    nameZh: string;
    type: string;
    level: number;
    shiny: boolean;
    hp: number;
    maxHp: number;
    exp: number;
    moves: WildMoveOption[];
  };
  captureChances: WildBallOption[];
  masterBallBonus: number;
  log: WildTurnLog[];
  captured: Pokemon | null;
}

export interface WildAction {
  type: 'move' | 'ball' | 'run';
  moveId?: string;
  ballItemId?: string;
}

export interface TradeAssets {
  pokemonIds: string[];
  itemIds: string[];
  points: number;
}

export interface Trade {
  id: string;
  fromId: string;
  toId: string;
  offer: TradeAssets;
  request: TradeAssets;
  manifestHash: string;
  confirmations: { from: boolean; to: boolean };
  status: 'OPEN' | 'EXECUTED' | 'CANCELLED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
}

export type BattleActionType = 'move' | 'switch' | 'item' | 'run';

export interface BattleAction {
  type: BattleActionType;
  moveId?: string;
  targetPokemonId?: string;
  itemId?: string;
}

export interface BattleMonState {
  pokemonId: string;
  speciesId: number;
  name: string;
  type: string;
  level: number;
  hp: number;
  maxHp: number;
  /** move ids (服务端引擎只下发 id，名称表在后端 game-data) */
  moves: string[];
  fainted: boolean;
}

export interface BattleSideState {
  /** index into team */
  active: number;
  team: BattleMonState[];
  mustSwitch: boolean;
  acted: boolean;
}

export type BattleOutcome = { winnerSide: 'A' | 'B' } | { draw: true } | null;

/**
 * 一次已结算回合的事件（服务端引擎 EngineEvent）：`kind` + 出手方 `side` + `detail`。
 * 攻击/受击/异常/能力阶级事件的 `detail` 带 `pokemonId`（受影响单位）与
 * `attacker`/`defender`（出手方/目标方 id），前端据此换成 i18n 名称渲染中文日志。
 */
export interface BattleLogEvent {
  kind:
    | 'switch'
    | 'move'
    | 'miss'
    | 'damage'
    | 'faint'
    | 'run'
    | 'win'
    | 'paralyzed'
    | 'status'
    | 'status-damage'
    | 'stat'
    | 'drain'
    | 'recoil';
  side?: 'A' | 'B';
  detail: Record<string, unknown>;
}

/** 已结算回合的日志条目（publicState().log，随每次 battle:state 推送） */
export interface BattleTurnLog {
  turn: number;
  /** 双方本回合提交的动作（槽位/换宠目标等，展示用可忽略） */
  actions?: { A?: Record<string, unknown>; B?: Record<string, unknown> };
  events: BattleLogEvent[];
}

/** 服务端引擎 publicState() —— battle:state 推送包里的 state 字段 */
export interface BattleState {
  turn: number;
  A: BattleSideState;
  B: BattleSideState;
  finished: boolean;
  outcome: BattleOutcome;
  /** 每个已结算回合的完整事件日志（BattleView 实时滚动日志面板的数据源） */
  log?: BattleTurnLog[];
}

/** GET /battles/moves 的技能元数据（战斗界面展示 威力/命中/属性/说明） */
export interface BattleMoveInfo {
  id: string;
  name: string;
  type: string;
  power: number;
  /** percent 0-100 */
  accuracy: number;
  category: 'physical' | 'special';
  /** 效果说明（效果系统落地前为空串） */
  effectText: string;
}

export interface BattleMoveCatalogResponse {
  moves: BattleMoveInfo[];
}

/** WS battle:error 推送包 */
export interface BattleErrorPush {
  code: string;
  message?: string;
  /** 触发错误的那次 battle:action 的 seq */
  seq?: number;
}

/** WS battle:state 推送包（you 仅在 battle:join 应答时携带） */
export interface BattleStatePush {
  battleId: string;
  state: BattleState;
  you?: 'A' | 'B';
}

export interface BattleTurn {
  awaitingPlayerIds: string[];
  deadline: number; // epoch ms
}

export interface BattleEnd {
  winnerId: string; // 用户名 或 'DRAW'
  resultHash: string;
  serverSig: string;
  reason: string;
}

/** 押注道具数量引用：id 指向堆叠实例，qty 为押注数量（整堆押注即 qty=堆叠总量） */
export interface WagerItemRef {
  id: string;
  qty: number;
}

/** 创建/加入房间请求体的押注形态（用户输入）：道具一律显式给数量，整堆=qty=堆叠总量 */
export interface WagerRequest {
  pokemonIds: string[];
  items: WagerItemRef[];
  points: number;
}

/**
 * 房间/链上归一后的押注包（GET /battles/rooms 的 wagerA/wagerB、BattleDetail）：
 * 形状与链码 `Battle.wager` 一致；链上 `qty=0` 是旧格式 itemIds 归一出的整堆标记。
 */
export interface WagerBundle {
  pokemonIds: string[];
  items: WagerItemRef[];
  points: number;
}

export interface BattleRoom {
  id: string;
  battleId: string | null;
  mode: '1v1';
  /** 房主自定义房名（空串 = 未命名，展示时回退"房主 X 的房间"）；后端已 trim+HTML 转义 */
  name?: string;
  /** 房主备注：赌什么 / 规则 */
  note?: string;
  playerA: string;
  playerB: string | null;
  wagerA: WagerBundle;
  wagerB: WagerBundle | null;
  teamA: string[];
  teamB: string[] | null;
  /** 加入者留言（房主在确认面板看到），无留言为 null */
  joinMessage?: string | null;
  confirmations: { A: boolean; B: boolean };
  /** STARTING/FAILED 是 H5 启动补偿的瞬态：大厅不展示，前端仅做兜底标签 */
  status: 'WAITING' | 'JOINED' | 'STARTING' | 'ACTIVE' | 'FINISHED' | 'FAILED';
  createdAt: string;
  updatedAt?: string;
}

/** 押注明细：宝可梦一项（GET /battles/rooms/:id 的 wagerDetailA/B 富化结果） */
export interface WagerPokemonDetail {
  id: string;
  /** 链上种族英文名（资产读不到时为 null） */
  name: string | null;
  speciesId: number | null;
  /** 中文可读名 */
  nameZh: string | null;
  level: number | null;
  shiny: boolean;
  /** 羁绊值 0-255 */
  bond: number | null;
  /** 最终六项能力值（种族值+IV+EV+等级+性格） */
  stats: Stats | null;
  /** 链上读不到（已消耗/已易主后清理） */
  unavailable: boolean;
}

export interface WagerItemDetail {
  id: string;
  typeId: string;
  name: string;
  nameZh: string;
  /** 押注数量 */
  qty: number;
  /** 该堆叠当前持有量（0 = 链上已不存在） */
  held: number;
  unavailable: boolean;
}

export interface WagerDetail {
  points: number;
  pokemon: WagerPokemonDetail[];
  items: WagerItemDetail[];
  totals: { pokemon: number; itemQty: number; points: number };
}

/** GET /battles/rooms/:id：房间本体 + 双方押注/出战队伍富化明细（"查看押注"/"查看队伍"弹窗） */
export interface BattleRoomDetail extends BattleRoom {
  wagerDetailA: WagerDetail;
  wagerDetailB: WagerDetail | null;
  /** 房主出战队伍（所有人可见，含旁观者） */
  teamDetailA: WagerPokemonDetail[];
  /** 加入者出战队伍（未加入时为 null） */
  teamDetailB: WagerPokemonDetail[] | null;
}

/** 常用押注模板（GET /battles/templates，每用户最多 10 个） */
export interface WagerTemplate {
  id: string;
  name: string;
  note: string;
  wager: WagerBundle;
  createdAt?: string | null;
}

/** 自己的屏蔽名单一项（TTL 30 分钟） */
export interface BlockedPlayer {
  playerId: string;
  blockedAt: string;
  expiresAt: string;
  /** 剩余有效期（毫秒） */
  remainingMs: number;
}

export interface BattleResult {
  winnerId: string;
  resultHash: string;
  serverSig: string;
  serverSubmitted: boolean;
  confirmations: { A: boolean; B: boolean };
}

/** 链上 Battle 状态（docs/chaincode-api.md §1 Battle） */
export interface BattleDetail {
  id: string;
  playerA: string;
  playerB: string;
  wagerA: WagerBundle;
  wagerB: WagerBundle;
  wagerHash: string;
  status: 'CREATED' | 'ACTIVE' | 'RESULT_SUBMITTED' | 'SETTLED' | 'DISPUTED' | 'REFUNDED';
  escrow?: { pointsA: number; pointsB: number };
  result?: BattleResult;
  disputeReason?: string;
  arbiterNote?: string;
  createdAt?: string;
  settledAt?: string;
}

/** GET /battles/:id 响应：链上状态 + 服务端实时引擎状态（未开播/已结束为 null） */
export interface BattleDetailResponse {
  battle: BattleDetail;
  live: BattleState | null;
  /** 本局对应的房间 id（房间已被对账清理时为 null，"查看押注"据此隐藏） */
  roomId?: string | null;
}

/** GET /battles?status=disputed 列表项（admin/arbitrator） */
export interface DisputeEntry {
  id: string;
  playerA: string;
  playerB: string;
  status: 'DISPUTED' | 'ARBITRATED';
  disputeReason: string;
  raisedBy: string;
  outcome: string | null;
  arbiterNote: string | null;
  createdAt?: string;
  resolvedAt?: string | null;
}

export interface AssetManifestEntry {
  uri: string;
  sha256: string;
  size: number;
}

/** GET /fairness/:eventId 里的链上 RandomCommit 记录 */
export interface FairnessEvent {
  eventId: string;
  purpose: 'capture' | 'battle' | 'mint';
  playerId: string;
  commitHash: string;
  clientSeed: string;
  serverSeed: string;
  resultHash: string;
  meta?: string;
  status: 'COMMITTED' | 'REVEALED' | 'CONSUMED';
}

/** 战斗回放与签名（P2-3；仅 ev_battle_<battleId> 事件返回） */
export interface FairnessBattle {
  battleId: string;
  /** 链上结果；平局为 'DRAW' */
  winnerId: string;
  /** sha256(canonical(turnLog))；回放日志缺失时为链上 resultHash */
  resultHash: string;
  /** DER hex（secp256k1 over sha256(resultHash bytes)） */
  serverSig: string;
  serverKeyId: string;
  /** battle_logs.turns_json；缺失/旧记录为 null */
  turnLog: unknown[] | null;
}

/** GET /fairness/:eventId 完整响应 */
export interface FairnessResponse {
  event: FairnessEvent;
  /** serverSeed 是否已揭示（H9：COMMITTED 阶段为 false，接口裁剪 serverSeed/resultHash） */
  revealed?: boolean;
  note?: string;
  derivation: Record<string, string>;
  serverPublicKey: string;
  /** 签名公钥指纹（H19；换钥后用于识别旧 serverSig 对应哪把公钥） */
  serverKeyId?: string;
  /** 战斗事件额外披露的回放日志 + resultHash 签名（P2-3） */
  battle?: FairnessBattle;
}

export interface ApiError {
  statusCode: number;
  code: string;
  message: string;
}

// ---------------------------------------------------------------- 排位 / 羁绊
// 与 docs/backend-api.md §11 对齐（GET /ranked/*、战斗结算面板数据）

export type RankedQueueState = 'IDLE' | 'QUEUED' | 'MATCH_PENDING' | 'MATCHED' | 'TIMEOUT' | 'ERROR';

/** 排队模式：casual=只争 rating；arena=积分场（按段位收准入积分，胜者通吃 + 补贴） */
export type RankedQueueMode = 'casual' | 'arena';

/** GET/POST/DELETE /ranked/queue 系列响应 */
export interface RankedQueueStatus {
  state: RankedQueueState;
  mode?: RankedQueueMode;
  rating?: number;
  nickname?: string;
  teamPokemonIds?: string[];
  /** 已等待毫秒 */
  waitedMs?: number;
  /** 已等待秒数 */
  waitedSec?: number;
  /** 当前匹配窗口（±N，随等待时间扩圈） */
  window?: number;
  queueSize?: number;
  /** 排队满 60 秒仍无真人：可以接受机器人对手 */
  botOffer?: boolean;
  /** 今天还能打几场机器人（每日上限 5 场） */
  botRemainingToday?: number;
  /** 本场准入积分（casual 恒为 0） */
  entryFee?: number;
  /** MATCH_PENDING：接受期截止（epoch ms） */
  acceptDeadline?: number;
  /** MATCH_PENDING：自己是否已接受 */
  accepted?: boolean;
  /** MATCHED：对手是机器人（奖励减半的练习赛） */
  bot?: boolean;
  roomId?: string | null;
  battleId?: string;
  opponent?: { playerId: string; nickname: string; rating: number; team?: RankedOpponentPokemon[] };
  message?: string;
}

/**
 * 排位接受期的对手阵容一项（docs/backend-api.md §11.1）：只有对局里可见的信息——
 * 昵称（链上 name）、种族、等级、闪光与最终能力值；**不含 IV/EV/性格/羁绊**（对手视角不可见）。
 */
export interface RankedOpponentPokemon {
  id: string;
  name: string | null;
  speciesId: number | null;
  nameZh: string | null;
  level: number | null;
  shiny: boolean;
  stats: Stats | null;
}

export interface RankedEntry {
  rank: number;
  playerId: string;
  nickname: string;
  rating: number;
  wins: number;
  losses: number;
  isMe?: boolean;
  /** 仅 GET /ranked/me：榜单总人数 */
  total?: number;
}

export interface RankedLeaderboard {
  top: RankedEntry[];
  me: RankedEntry | null;
}

export interface RankedRatingChange {
  playerId: string;
  before: number;
  after: number;
  delta: number;
}

/** 一只宝可梦的羁绊变化（PvP 结算后） */
export interface RankedBondChange {
  pokemonId: string;
  speciesId: number;
  name: string;
  side: 'A' | 'B';
  result: 'WIN' | 'LOSS' | 'DRAW';
  before: number;
  after: number;
  delta: number;
}

/** GET /ranked/battles/:id/outcome：结算面板的排位分 / 羁绊变化 */
export interface BattleRewardOutcome {
  /** PENDING=结算中（链上还没 SETTLED），NONE=没有奖励记录 */
  status?: 'PENDING' | 'NONE';
  battleId: string;
  ranked?: boolean;
  winnerId?: string;
  settledAt?: string;
  ratings?: RankedRatingChange[];
  bonds?: RankedBondChange[];
  /** 机器人场：奖励减半（ELO/羁绊/经验 ×0.5） */
  bot?: boolean;
  /** 积分场结算明细（准入 / 补贴 / 发奖） */
  arena?: RankedArenaSettlement;
}

/** 积分场（arena）结算留痕：准入额 + 固化后的发奖计划 */
export interface RankedArenaSettlement {
  entryA: number;
  entryB: number;
  applied?: boolean;
  plan?: {
    winnerId: string;
    /** 实际发放的系统补贴（0 = 不发） */
    subsidy: number;
    subsidyTo: string | null;
    /** 不发补贴的原因（防刷规则命中） */
    subsidyBlocked?: 'DAILY_LIMIT' | 'RATING_GAP' | 'BOT';
    payouts: Array<{ playerId: string; points: number; reason: string; idemKey: string }>;
  };
}
