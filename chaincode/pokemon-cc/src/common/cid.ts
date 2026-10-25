import { Context } from 'fabric-contract-api';
import { fail } from './assert';

export const ORG1_MSP = 'Org1MSP';
export const ORG2_MSP = 'Org2MSP';

export type Role = 'player' | 'admin' | 'system' | 'arbitrator';

export const ROLES: Role[] = ['player', 'admin', 'system', 'arbitrator'];

export function getMspId(ctx: Context): string {
  return ctx.clientIdentity.getMSPID();
}

/** 角色取 CID attr `role`，缺省为 player（docs/chaincode-api.md §0.2）。 */
export function getRole(ctx: Context): string {
  return ctx.clientIdentity.getAttributeValue('role') || 'player';
}

/**
 * CA 在 ecert 中自动写入的登记身份：`hf.EnrollmentID`（= 注册时的 id.name）。
 * 本项目 `playerId === username === enrollmentID`，因此它是"用户是谁"的链上唯一依据
 * （docs/chaincode-api.md §0.2、docs/security.md §1.2）。
 * 手工签发的证书可能没有该属性：返回空串，由调用方按"非本人"拒绝，不回退 mspId。
 */
export function getEnrollmentId(ctx: Context): string {
  return ctx.clientIdentity.getAttributeValue('hf.EnrollmentID') ?? '';
}

export function requireRole(ctx: Context, ...roles: string[]): string {
  const role = getRole(ctx);
  if (!roles.includes(role)) {
    fail('FORBIDDEN', `requires role [${roles.join('|')}], caller role is "${role}"`);
  }
  return role;
}

export function assertMsp(ctx: Context, mspId: string): void {
  const caller = getMspId(ctx);
  if (caller !== mspId) {
    fail('FORBIDDEN', `requires msp ${mspId}, caller msp is ${caller}`);
  }
}

/** 仲裁人：Org2MSP 且 role=arbitrator。 */
export function requireArbitrator(ctx: Context): void {
  assertMsp(ctx, ORG2_MSP);
  requireRole(ctx, 'arbitrator');
}
