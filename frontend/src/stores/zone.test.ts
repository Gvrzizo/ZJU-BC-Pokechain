import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { getZones } from '@/api/capture';
import type { CaptureZonesResponse } from '@/types';
import {
  DEFAULT_ZONE_ID,
  ZONE_ALIASES,
  ZONE_IDS,
  loadZones,
  lureAllowed,
  resetZonesForTest,
  resolveZoneId,
  setZonesForTest,
  useZoneStore,
  zoneById,
  zoneHint,
  zoneLabel,
  zoneLevelText,
} from './zone';
import { ZONES_FIXTURE } from './zone.fixture';

vi.mock('@/api/capture', () => ({ getZones: vi.fn() }));

const mockedGetZones = vi.mocked(getZones);

/** 区域表（docs/backend-api.md §2「区域与栖息地野生池」）：数据由 GET /capture/zones 提供，前端不镜像 */
describe('区域表：后端 API 是唯一事实来源', () => {
  beforeEach(() => {
    resetZonesForTest();
    mockedGetZones.mockReset();
  });

  it('未加载时只有 town + 最小缺省区占位，不镜像等级带', () => {
    expect(zoneById('town')).toMatchObject({ id: 'town', name: '未白镇', safe: true });
    expect(zoneById('route-grass')).toMatchObject({ id: 'route-grass', name: '101 号道路·草丛' });
    // 等级带/门槛来自后端：数据没到之前不编造
    expect(zoneById('route-grass').minLevel).toBeUndefined();
    expect(zoneById('route-grass').maxLevel).toBeUndefined();
    expect(zoneLevelText(zoneById('route-grass'))).toBe('');
    expect(zoneHint(zoneById('route-grass'))).toBe('');
    // 已知的野外 id 即使数据未到也保留 id，遇敌请求不会错发成缺省区
    expect(zoneById('volcano').id).toBe('volcano');
    expect(zoneById('nope').id).toBe(DEFAULT_ZONE_ID);
    expect(resolveZoneId('nope')).toBeUndefined();
  });

  it('load() 拉取一次并缓存（13 个后端区 + 前端 town）', async () => {
    mockedGetZones.mockResolvedValue(ZONES_FIXTURE);
    setActivePinia(createPinia());
    const store = useZoneStore();
    await store.load();
    await store.load();
    await loadZones();
    expect(mockedGetZones).toHaveBeenCalledTimes(1);

    // 后端 13 区 + town 全部可解析
    expect(ZONE_IDS).toHaveLength(14);
    for (const id of ZONE_IDS) expect(zoneById(id).id).toBe(id);
    expect(zoneById('route-grass')).toMatchObject({ name: '101 号道路·草丛', minLevel: 2, maxLevel: 6, maxStage: 0 });
    expect(zoneById('cave')).toMatchObject({ name: '石之洞窟', minLevel: 12, maxLevel: 20, maxStage: 1 });
    expect(zoneById('route-north')).toMatchObject({ name: '冠军之路', minLevel: 17, maxLevel: 28, maxStage: 2 });
    expect(zoneById('town')).toMatchObject({ name: '未白镇', safe: true });
  });

  it('等级带/门槛/门控全部来自响应（改后端表前端自动跟随）', async () => {
    const custom: CaptureZonesResponse = {
      ...ZONES_FIXTURE,
      zones: ZONES_FIXTURE.zones.map((z) =>
        z.id === 'cave' ? { ...z, name: '石之洞窟（后端新名）', minLevel: 13, maxLevel: 21, maxStage: 2 } : z,
      ),
    };
    setZonesForTest(custom);
    expect(zoneById('cave')).toMatchObject({ name: '石之洞窟（后端新名）', minLevel: 13, maxLevel: 21, maxStage: 2 });
    expect(zoneLabel(zoneById('cave'))).toBe('石之洞窟（后端新名） Lv13-21');
  });

  it('传说区：等级带 + 钥匙 + 池内传说 + 禁止诱饵', async () => {
    mockedGetZones.mockResolvedValue(ZONES_FIXTURE);
    await loadZones();
    const legendary = ZONE_IDS.filter((id) => zoneById(id).legendary);
    expect(legendary).toEqual([
      'sky-pillar',
      'seafloor',
      'magma',
      'ruins',
      'southern-island',
      'birth-island',
    ]);
    for (const id of legendary) {
      const zone = zoneById(id);
      expect(zoneLevelText(zone)).toMatch(/^Lv\d\d-\d\d$/);
      expect(zone.legendary!.keyTypeId).toBeTruthy();
      expect(zone.legendary!.speciesIds.length).toBeGreaterThan(0);
      // 传说区禁止诱饵（后端 LURE_NOT_ALLOWED）
      expect(lureAllowed(zone)).toBe(false);
    }
    expect(zoneById('sky-pillar').legendary).toMatchObject({ speciesIds: [384], keyTypeId: 'sky-key' });
    expect(zoneById('seafloor').legendary).toMatchObject({ speciesIds: [382], keyTypeId: 'ocean-key' });
    expect(zoneById('magma').legendary).toMatchObject({ speciesIds: [383], keyTypeId: 'magma-key' });
    expect(zoneById('ruins').legendary).toMatchObject({ speciesIds: [377, 378, 379], keyTypeId: 'ruins-key' });
    expect(zoneById('southern-island').legendary).toMatchObject({ speciesIds: [380, 381], keyTypeId: 'island-key' });
    expect(zoneById('birth-island').legendary).toMatchObject({ speciesIds: [386], keyTypeId: 'birth-key' });
    expect(zoneHint(zoneById('sky-pillar'))).toBe('传说出没：烈空坐');
  });

  it('旧 id 兼容别名：south/mid/north → 三个 route 区', () => {
    expect(ZONE_ALIASES).toEqual({ south: 'route-grass', mid: 'route-mid', north: 'route-north' });
    expect(resolveZoneId('south')).toBe('route-grass');
    expect(resolveZoneId('north')).toBe('route-north');
    expect(zoneById('mid').id).toBe('route-mid');
    expect(zoneById('nope').id).toBe(DEFAULT_ZONE_ID);
  });

  it('缺省区跟随响应里的 default（不是硬编码在前端）', () => {
    setZonesForTest({ ...ZONES_FIXTURE, default: 'southern-island' });
    expect(zoneById('nope').id).toBe('southern-island');
    // 非法 default 回退常量
    setZonesForTest({ ...ZONES_FIXTURE, default: 'not-a-zone' });
    expect(zoneById('nope').id).toBe(DEFAULT_ZONE_ID);
  });

  it('zoneLabel / zoneHint / 安全区文案', async () => {
    mockedGetZones.mockResolvedValue(ZONES_FIXTURE);
    await loadZones();
    expect(zoneLabel(zoneById('route-grass'))).toBe('101 号道路·草丛 Lv2-6');
    expect(zoneLabel(zoneById('route-north'))).toBe('冠军之路 Lv17-28');
    expect(zoneLabel(zoneById('sky-pillar'))).toBe('天空之柱 Lv45-50');
    expect(zoneLabel(zoneById('town'))).toBe('未白镇');
    expect(zoneHint(zoneById('route-grass'))).toBe('未进化型出没');
    expect(zoneHint(zoneById('coast'))).toBe('可见进化型');
    expect(zoneHint(zoneById('route-north'))).toBe('进化型领地');
    expect(zoneHint(zoneById('town'))).toBe('没有野生宝可梦');
    expect(lureAllowed(zoneById('route-grass'))).toBe(true);
    expect(lureAllowed(zoneById('town'))).toBe(true);
  });

  it('拉取失败时优雅降级：不抛错、town/缺省区可用、已知 id 不丢', async () => {
    mockedGetZones.mockRejectedValue(new Error('offline'));
    await expect(loadZones()).resolves.toBeUndefined();
    expect(zoneById('town')).toMatchObject({ name: '未白镇', safe: true });
    expect(zoneById('route-grass')).toMatchObject({ id: DEFAULT_ZONE_ID, name: '101 号道路·草丛' });
    expect(zoneById('route-grass').minLevel).toBeUndefined();
    expect(zoneLabel(zoneById('route-grass'))).toBe('101 号道路·草丛');
    // 已知区域 id 仍保留（遇敌请求发对区），未知 id 回退缺省区
    expect(zoneById('seafloor').id).toBe('seafloor');
    expect(zoneById('nope').id).toBe(DEFAULT_ZONE_ID);
  });

  it('失败后下一次 load() 会重试并成功', async () => {
    mockedGetZones.mockRejectedValueOnce(new Error('offline'));
    await loadZones();
    expect(mockedGetZones).toHaveBeenCalledTimes(1);
    mockedGetZones.mockResolvedValueOnce(ZONES_FIXTURE);
    await loadZones();
    expect(mockedGetZones).toHaveBeenCalledTimes(2);
    expect(zoneById('cave').name).toBe('石之洞窟');
  });
});

describe('zone store', () => {
  beforeEach(() => {
    resetZonesForTest();
    mockedGetZones.mockReset();
    setActivePinia(createPinia());
  });

  it('enter 接受新 id 与旧别名，非法值回退缺省区', () => {
    const store = useZoneStore();
    store.enter('cave');
    expect(store.id).toBe('cave');
    store.enter('south');
    expect(store.id).toBe('route-grass');
    store.enter('not-a-zone');
    expect(store.id).toBe(DEFAULT_ZONE_ID);
  });

  it('数据到达后 label 自动跟随（模块缓存是响应式的）', async () => {
    mockedGetZones.mockResolvedValue(ZONES_FIXTURE);
    const store = useZoneStore();
    store.enter('cave');
    expect(store.label).toBe('cave'); // 占位：只有 id，没有等级带
    await store.load();
    expect(store.label).toBe('石之洞窟 Lv12-20');
    store.enter('south');
    expect(store.label).toBe('101 号道路·草丛 Lv2-6');
  });
});
