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
