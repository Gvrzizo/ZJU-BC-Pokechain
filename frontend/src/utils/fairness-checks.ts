import type { FairnessResponse } from '@/types';
import { canonicalize } from './canonical';
import { sha256Hex } from './hash';
import { verifyResultSignature } from './verify-signature';

export interface FairnessCheck {
  label: string;
  pass: boolean;
  detail?: string;
}

/**
 * 公平性页的所有前端复算/验签项，抽成纯函数便于单测（组件只负责展示）。
 * - 捕捉侧：承诺-揭示、链上 resultHash、派生流抽查；
 * - 战斗侧（P2-3）：sha256(canonical(turnLog)) == battle.resultHash、serverSig 验签。
 * 派生流抽查只证明算法可复现，不代表对局结果；战斗结论以回放复算 + 验签为准。
 */
export async function buildFairnessChecks(record: FairnessResponse): Promise<FairnessCheck[]> {
  const ev = record.event;
  const checks: FairnessCheck[] = [];

  // ① commitHash == sha256(serverSeed)
  if (ev.serverSeed) {
    const commit = await sha256Hex(ev.serverSeed);
    checks.push({
      label: 'sha256(serverSeed) == commitHash',
      pass: commit === ev.commitHash,
      ...(commit === ev.commitHash ? {} : { detail: `commitHash=${ev.commitHash || '—'}，复算=${commit}` }),
    });
  } else {
    // H9：结算前只公开承诺，serverSeed 在结算（投中/战斗终态/超时）后揭示
    checks.push({
      label: '承诺已上链；serverSeed 将在结算后揭示（当前无需/无法复算）',
      pass: true,
      detail: record.note,
    });
  }

  // ② resultHash == sha256(serverSeed|clientSeed|eventId)（若链上已写入）
  if (ev.serverSeed && ev.resultHash) {
    const rh = await sha256Hex(`${ev.serverSeed}|${ev.clientSeed}|${ev.eventId}`);
    checks.push({
      label: 'sha256(serverSeed|clientSeed|eventId) == resultHash',
      pass: rh === ev.resultHash,
      ...(rh === ev.resultHash ? {} : { detail: `链上=${ev.resultHash}，复算=${rh}` }),
    });
  }

  // ③ 派生流抽查：只验证 HMAC 算法可复现，不证明对局结果（战斗结论看 battle 两项）
  if (ev.serverSeed) {
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(ev.serverSeed),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const sig = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${ev.clientSeed}|${ev.eventId}|0`),
      );
      const view = new DataView(sig);
      const rand0 = (view.getUint32(0) * 2 ** 32 + view.getUint32(4)) / 2 ** 64;
      checks.push({
        label: `派生流抽查：HMAC 第 0 值可复现（rand0=${rand0.toFixed(6)} ∈ [0,1)；不代表对局结果）`,
        pass: rand0 >= 0 && rand0 < 1,
      });
    } catch {
      checks.push({ label: '派生流抽查：HMAC 重算失败', pass: false });
    }
  }

  // ④ 战斗回放：sha256(canonical(turnLog)) 必须等于签名覆盖的 battle.resultHash
  const battle = record.battle;
  if (battle) {
    if (battle.turnLog) {
      const recomputed = await sha256Hex(canonicalize(battle.turnLog));
      checks.push({
        label: 'sha256(canonical(回合日志)) == battle.resultHash',
        pass: recomputed === battle.resultHash,
        detail:
          recomputed === battle.resultHash
            ? `复算=${recomputed}`
            : `链上=${battle.resultHash || '—'}，复算=${recomputed}；回放日志与签名结果不一致`,
      });
    } else {
      // 没有回放日志就无法独立复算 resultHash：只展示链上签名，不能标记通过
      checks.push({
        label: '无回放日志，仅展示链上签名',
        pass: false,
        detail: 'battle_logs 缺失（可能由对账/仲裁产生），无法独立复算 resultHash',
      });
    }

    // ⑤ 验签：digest = sha256(resultHash bytes)，secp256k1(DER over sha256)
    if (battle.resultHash && battle.serverSig && record.serverPublicKey) {
      const ok = await verifyResultSignature(
        battle.resultHash,
        battle.serverSig,
        record.serverPublicKey,
      );
      checks.push({
        label: 'serverSig 验签通过（secp256k1）',
        pass: ok,
        detail: ok
          ? `serverKeyId=${battle.serverKeyId || record.serverKeyId || '—'}`
          : '签名与当前服务端公钥 / resultHash 不匹配（换钥、篡改或非本服务所签）',
      });
    } else {
      checks.push({
        label: 'serverSig 验签通过（secp256k1）',
        pass: false,
        detail: '缺少 serverSig、resultHash 或服务端公钥，无法验签',
      });
    }
  }

  return checks;
}
