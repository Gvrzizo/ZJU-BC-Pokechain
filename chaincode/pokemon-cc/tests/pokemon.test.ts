import { expectCode, hash, IVS_JSON, MOVES_JSON, ORG1, ORG2, T1, T2, T3, World } from './helpers/harness';

describe('PokemonContract（捕捉铸造全流程）', () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.registerPlayer('u_ash', ORG1);
    await w.registerPlayer('u_gary', ORG2);
  });

  test('Commit→Reveal→MintFromCapture：铸造成功、rand→CONSUMED、初始 IDLE/level5', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    const p = await w.getPokemon('p_1');
    expect(p).toMatchObject({
      docType: 'pokemon',
      id: 'p_1',
      speciesId: 25,
      name: '皮卡丘',
      ownerId: 'u_ash',
      status: 'IDLE',
      lockRef: '',
      level: 5,
      exp: 0,
      captureEventId: 'ev_p_1',
      shiny: false,
    });
    expect(p.ivs).toEqual({ hp: 10, atk: 12, def: 8, spatk: 15, spdef: 14, speed: 20 });
    expect(p.evs).toEqual({ hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 });
    expect(p.moves).toEqual(['thunder-shock', 'growl']);
    expect((await w.getRand('ev_p_1')).status).toBe('CONSUMED');
  });

  test('MintFromCapture：同一随机事件重复消费被拒（RAND_CONSUMED）', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    await expectCode(
      w.run(() =>
        w.pokemon.MintFromCapture(w.systemCtx(), 'p_2', 'u_ash', '25', 'x', IVS_JSON, 'hardy', 'static', 'false', MOVES_JSON, hash('dna-p_2'), 'ev_p_1', T2, 'idem-mint-p_2'),
      ),
      'RAND_CONSUMED',
    );
  });

  test('MintFromCapture：未揭示的随机事件抛 RAND_NOT_REVEALED；purpose/playerId 不匹配被拒', async () => {
    // 只 Commit 不 Reveal
    await w.run(() =>
      w.random.Commit(w.systemCtx(), 'ev_x', 'capture', 'u_ash', hash('seed-x'), 'aabb', T1, 'idem-commit-ev_x'),
    );
    await expectCode(
      w.run(() =>
        w.pokemon.MintFromCapture(w.systemCtx(), 'p_1', 'u_ash', '25', 'x', IVS_JSON, 'hardy', 'static', 'false', MOVES_JSON, hash('dna-p_1'), 'ev_x', T2, 'idem-m1'),
      ),
      'RAND_NOT_REVEALED',
    );
    // purpose 不匹配
    await w.commitReveal('ev_b', 'battle', 'u_ash');
    await expectCode(
      w.run(() =>
        w.pokemon.MintFromCapture(w.systemCtx(), 'p_2', 'u_ash', '25', 'x', IVS_JSON, 'hardy', 'static', 'false', MOVES_JSON, hash('dna-p_2'), 'ev_b', T2, 'idem-m2'),
      ),
      'PURPOSE_MISMATCH',
    );
    // playerId 不匹配
    await w.commitReveal('ev_c', 'capture', 'u_gary');
    await expectCode(
      w.run(() =>
        w.pokemon.MintFromCapture(w.systemCtx(), 'p_3', 'u_ash', '25', 'x', IVS_JSON, 'hardy', 'static', 'false', MOVES_JSON, hash('dna-p_3'), 'ev_c', T2, 'idem-m3'),
      ),
      'RAND_PLAYER_MISMATCH',
    );
  });

  test('MintFromCapture：ivs 越界 / moves>4 / id 已存在 被拒', async () => {
    await w.commitReveal('ev_v', 'capture', 'u_ash');
    const badIvs = JSON.stringify({ hp: 32, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 });
    await expectCode(
      w.run(() =>
        w.pokemon.MintFromCapture(w.systemCtx(), 'p_1', 'u_ash', '25', 'x', badIvs, 'hardy', 'static', 'false', MOVES_JSON, hash('dna-p_1'), 'ev_v', T2, 'idem-m4'),
      ),
      'INVALID_PARAM',
    );
    const tooManyMoves = JSON.stringify(['a', 'b', 'c', 'd', 'e']);
    await expectCode(
      w.run(() =>
        w.pokemon.MintFromCapture(w.systemCtx(), 'p_1', 'u_ash', '25', 'x', IVS_JSON, 'hardy', 'static', 'false', tooManyMoves, hash('dna-p_1'), 'ev_v', T2, 'idem-m5'),
      ),
      'INVALID_PARAM',
    );
    await w.capturePokemon('p_dup', 'u_ash');
    await w.commitReveal('ev_dup2', 'capture', 'u_ash');
    await expectCode(
      w.run(() =>
        w.pokemon.MintFromCapture(w.systemCtx(), 'p_dup', 'u_ash', '25', 'x', IVS_JSON, 'hardy', 'static', 'false', MOVES_JSON, hash('dna-p_dup'), 'ev_dup2', T2, 'idem-m6'),
      ),
      'POKEMON_EXISTS',
    );
  });

  test('MintFromCapture：仅 system；玩家证书不能铸造（FORBIDDEN），且随机事件不被消费', async () => {
    await w.commitReveal('ev_forge', 'capture', 'u_ash');
    await expectCode(
      w.run(() =>
        w.pokemon.MintFromCapture(
          w.ctxAs('u_ash'), 'p_forge', 'u_ash', '150', 'Mewtwo', IVS_JSON, 'hardy', 'pressure', 'true', MOVES_JSON,
          hash('dna-forge'), 'ev_forge', T2, 'idem-forge1',
        ),
      ),
      'FORBIDDEN',
    );
    expect((await w.getRand('ev_forge')).status).toBe('REVEALED');
    await expectCode(w.getPokemon('p_forge'), 'POKEMON_NOT_FOUND');
    // system 仍可正常铸造（回归：随机事件未被前面的越权调用消费）
    await w.run(() =>
      w.pokemon.MintFromCapture(
        w.systemCtx(), 'p_forge', 'u_ash', '25', '皮卡丘', IVS_JSON, 'hardy', 'static', 'false', MOVES_JSON,
        hash('dna-forge'), 'ev_forge', T2, 'idem-forge2',
      ),
    );
    expect((await w.getRand('ev_forge')).status).toBe('CONSUMED');
  });

  test('Transfer：owner 转移成功；非 owner 抛 NOT_OWNER；toId 必须存在', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    const p = JSON.parse(await w.run(() => w.pokemon.Transfer(w.ctxAs('u_ash'), 'p_1', 'u_gary', T3, 'idem-t1')));
    expect(p.ownerId).toBe('u_gary');
    expect(w.eventNames()).toContain('PokemonTransferred');
    await expectCode(w.run(() => w.pokemon.Transfer(w.ctxAs('u_ash'), 'p_1', 'u_ash', T3, 'idem-t2')), 'NOT_OWNER');
    await expectCode(w.run(() => w.pokemon.Transfer(w.ctxAs('u_gary'), 'p_1', 'u_nobody', T3, 'idem-t3')), 'PLAYER_NOT_FOUND');
  });

  test('Transfer/Release：同组织其他玩家不能转移/放生本人宝可梦（NOT_OWNER）', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    // u_gary 与 ash 同属 Org1MSP：只看 mspId 会被放行，故必须按 hf.EnrollmentID 拒绝
    await expectCode(w.run(() => w.pokemon.Transfer(w.ctxAs('u_gary'), 'p_1', 'u_gary', T3, 'idem-own1')), 'NOT_OWNER');
    await expectCode(w.run(() => w.pokemon.Release(w.ctxAs('u_gary'), 'p_1', T3, 'idem-own2')), 'NOT_OWNER');
    await expectCode(w.run(() => w.pokemon.Transfer(w.ctx(ORG1), 'p_1', 'u_gary', T3, 'idem-own3')), 'NOT_OWNER');
    expect(await w.getPokemon('p_1')).toMatchObject({ ownerId: 'u_ash', status: 'IDLE' });
  });

  test('ApplyGrowth：仅 system；level 单调不减且 1-100；moves ≤4', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    let p = JSON.parse(await w.run(() => w.pokemon.ApplyGrowth(w.systemCtx(), 'p_1', JSON.stringify({ level: 10, exp: 500 }), T3, 'idem-g1')));
    expect(p).toMatchObject({ level: 10, exp: 500 });
    p = JSON.parse(await w.run(() => w.pokemon.ApplyGrowth(w.systemCtx(), 'p_1', JSON.stringify({ moves: ['thunderbolt'] }), T3, 'idem-g2')));
    expect(p.moves).toEqual(['thunderbolt']);
    await expectCode(w.run(() => w.pokemon.ApplyGrowth(w.systemCtx(), 'p_1', JSON.stringify({ level: 9 }), T3, 'idem-g3')), 'INVALID_PARAM');
    await expectCode(w.run(() => w.pokemon.ApplyGrowth(w.systemCtx(), 'p_1', JSON.stringify({ level: 101 }), T3, 'idem-g4')), 'INVALID_PARAM');
    // owner 本人也不能直接写入（C3）：养成必须由后端校验成本后用 system 身份代签
    await expectCode(w.run(() => w.pokemon.ApplyGrowth(w.ctxAs('u_ash'), 'p_1', JSON.stringify({ level: 11 }), T3, 'idem-g5')), 'FORBIDDEN');
    await expectCode(w.run(() => w.pokemon.ApplyGrowth(w.ctxAs('u_gary'), 'p_1', JSON.stringify({ level: 11 }), T3, 'idem-g6')), 'FORBIDDEN');
    await expectCode(w.run(() => w.pokemon.ApplyGrowth(w.ctx(ORG1), 'p_1', JSON.stringify({ level: 11 }), T3, 'idem-g7')), 'FORBIDDEN');
    await expectCode(w.run(() => w.pokemon.ApplyGrowth(w.adminCtx(), 'p_1', JSON.stringify({ level: 11 }), T3, 'idem-g8')), 'FORBIDDEN');
  });

  test('ApplyGrowth：EV 更新合法路径 + 单项 0-255 / 总和 ≤510 校验', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    const evs = { hp: 4, atk: 252, def: 0, spatk: 0, spdef: 0, speed: 252 };
    const p = JSON.parse(
      await w.run(() => w.pokemon.ApplyGrowth(w.systemCtx(), 'p_1', JSON.stringify({ evs }), T3, 'idem-ev1')),
    );
    expect(p.evs).toEqual(evs);
    expect(w.eventNames()).toContain('PokemonGrowth');

    // 单项超 255
    await expectCode(
      w.run(() =>
        w.pokemon.ApplyGrowth(w.systemCtx(), 'p_1', JSON.stringify({ evs: { ...evs, atk: 256 } }), T3, 'idem-ev2'),
      ),
      'INVALID_PARAM',
    );
    // 总和超 510
    await expectCode(
      w.run(() =>
        w.pokemon.ApplyGrowth(
          w.systemCtx(),
          'p_1',
          JSON.stringify({ evs: { hp: 255, atk: 255, def: 1, spatk: 0, spdef: 0, speed: 0 } }),
          T3,
          'idem-ev3',
        ),
      ),
      'INVALID_PARAM',
    );
    // 负数 / 缺失字段 / 非整数
    await expectCode(
      w.run(() =>
        w.pokemon.ApplyGrowth(w.systemCtx(), 'p_1', JSON.stringify({ evs: { ...evs, speed: -4 } }), T3, 'idem-ev4'),
      ),
      'INVALID_PARAM',
    );
    await expectCode(
      w.run(() =>
        w.pokemon.ApplyGrowth(
          w.systemCtx(),
          'p_1',
          JSON.stringify({ evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0 } }),
          T3,
          'idem-ev5',
        ),
      ),
      'INVALID_PARAM',
    );
    await expectCode(
      w.run(() =>
        w.pokemon.ApplyGrowth(w.systemCtx(), 'p_1', JSON.stringify({ evs: { ...evs, atk: 12.5 } }), T3, 'idem-ev6'),
      ),
      'INVALID_PARAM',
    );
    // 非法更新不得写入：仍是上一次的合法值
    expect((await w.getPokemon('p_1')).evs).toEqual(evs);
  });

  test('ApplyGrowth：IV 变更（王冠类道具）——子集提升、未提及项不变、允许同值', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    const grown = JSON.parse(
      await w.run(() => w.pokemon.ApplyGrowth(w.systemCtx(), 'p_1', JSON.stringify({ ivs: { hp: 31, speed: 20 } }), T3, 'idem-iv1')),
    );
    expect(grown.ivs).toEqual({ hp: 31, atk: 12, def: 8, spatk: 15, spdef: 14, speed: 20 });
    expect(w.eventNames()).toContain('PokemonGrowth');
  });

  test('ApplyGrowth：IV 只能升不能降（IV_DECREASE）；越界/未知键/非整数/非对象拒绝且不落库', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    const grow = (ivs: unknown, key: string) =>
      w.run(() => w.pokemon.ApplyGrowth(w.systemCtx(), 'p_1', JSON.stringify({ ivs }), T3, key));
    await expectCode(grow({ hp: 9 }, 'idem-iv2'), 'IV_DECREASE');
    await expectCode(grow({ hp: 32 }, 'idem-iv3'), 'INVALID_PARAM');
    await expectCode(grow({ hp: -1 }, 'idem-iv4'), 'INVALID_PARAM');
    await expectCode(grow({ hp: 12, luck: 31 }, 'idem-iv5'), 'INVALID_PARAM');
    await expectCode(grow({ hp: 12.5 }, 'idem-iv6'), 'INVALID_PARAM');
    await expectCode(grow([31], 'idem-iv7'), 'INVALID_PARAM');
    expect((await w.getPokemon('p_1')).ivs).toEqual({ hp: 10, atk: 12, def: 8, spatk: 15, spdef: 14, speed: 20 });
  });

  test('ApplyGrowth：旧记录（无 evs 字段）可正常读取并按全 0 处理', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    // 模拟 evs 字段上线前的链上记录
    const legacy = await w.getPokemon('p_1');
    delete legacy.evs;
    await w.run(() =>
      w.stub.putState(
        'pokemon:p_1',
        Buffer.from(JSON.stringify(legacy)),
      ),
    );
    const loaded = await w.getPokemon('p_1');
    expect(loaded.evs).toEqual({ hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 });
    const grown = JSON.parse(
      await w.run(() => w.pokemon.ApplyGrowth(w.systemCtx(), 'p_1', JSON.stringify({ level: 6 }), T3, 'idem-legacy')),
    );
    expect(grown.evs).toEqual({ hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 });
  });

  test('Release：置 RELEASED、ownerId 清空；之后不可再转移', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    const p = JSON.parse(await w.run(() => w.pokemon.Release(w.ctxAs('u_ash'), 'p_1', T3, 'idem-rel1')));
    expect(p).toMatchObject({ status: 'RELEASED', ownerId: '' });
    expect(w.eventNames()).toContain('PokemonReleased');
    await expectCode(w.run(() => w.pokemon.Release(w.ctxAs('u_ash'), 'p_1', T3, 'idem-rel2')), 'PLAYER_NOT_FOUND');
  });

  test('QueryByOwner / QueryPokedex 富查询', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    await w.capturePokemon('p_2', 'u_ash');
    await w.capturePokemon('p_3', 'u_gary');
    const ashList = JSON.parse(await w.run(() => w.pokemon.QueryByOwner(w.systemCtx(), 'u_ash')));
    expect(ashList.map((x: { id: string }) => x.id).sort()).toEqual(['p_1', 'p_2']);
    const dex = JSON.parse(
      await w.run(() => w.pokemon.QueryPokedex(w.systemCtx(), JSON.stringify({ selector: { docType: 'pokemon', ownerId: 'u_gary' } }))),
    );
    expect(dex).toHaveLength(1);
    expect(dex[0].id).toBe('p_3');
    // selector 必须含 docType=pokemon
    await expectCode(w.run(() => w.pokemon.QueryPokedex(w.systemCtx(), JSON.stringify({ selector: { ownerId: 'u_gary' } }))), 'INVALID_PARAM');
  });

  test('锁定中的宝可梦不可转移（ASSET_LOCKED）', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    await w.capturePokemon('p_2', 'u_gary');
    const offer = JSON.stringify({ pokemonIds: ['p_1'], itemIds: [], points: 0 });
    const request = JSON.stringify({ pokemonIds: ['p_2'], itemIds: [], points: 0 });
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', offer, request, '2026-01-02T00:00:00.000Z', T3, 'idem-ct1'));
    await expectCode(w.run(() => w.pokemon.Transfer(w.ctxAs('u_ash'), 'p_1', 'u_gary', T3, 'idem-t9')), 'ASSET_LOCKED');
  });
});
