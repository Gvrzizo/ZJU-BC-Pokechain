import { buildCaRegistrationRequest } from '../src/fabric/fabric-ca.service';

/**
 * C4a 回归：注册请求只能带 role 属性。
 * Fabric CA 1.5 会自动写入 hf.EnrollmentID；显式注册该属性会被 403
 * （"cannot register attribute hf.EnrollmentID"），导致真链注册全部失败。
 */
describe('Fabric CA registration request (C4a)', () => {
  it('只注册 role 属性，ecert=true，不手动写 hf.EnrollmentID', () => {
    const req = buildCaRegistrationRequest('alice', 'player');
    expect(req.enrollmentID).toBe('alice');
    expect(req.role).toBe('client');
    expect(req.maxEnrollments).toBe(1);
    expect(req.affiliation).toBe('org1.department1');
    expect(req.attrs).toEqual([{ name: 'role', value: 'player', ecert: true }]);
    expect(req.attrs.some((a) => a.name === 'hf.EnrollmentID')).toBe(false);
  });

  it('system/admin 身份同样只带 role 属性', () => {
    expect(buildCaRegistrationRequest('system', 'system').attrs).toEqual([
      { name: 'role', value: 'system', ecert: true },
    ]);
    expect(buildCaRegistrationRequest('opsadmin', 'admin').attrs).toEqual([
      { name: 'role', value: 'admin', ecert: true },
    ]);
  });

  it('支持覆盖 affiliation（测试/多部门环境）', () => {
    expect(buildCaRegistrationRequest('bob', 'player', 'org1.dept2').affiliation).toBe('org1.dept2');
  });
});
