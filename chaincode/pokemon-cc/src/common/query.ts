import { Context } from 'fabric-contract-api';

/** 收集 CouchDB 富查询结果为 JSON 数组。 */
export async function collectQuery<T = unknown>(ctx: Context, query: string): Promise<T[]> {
  const iterator = await ctx.stub.getQueryResult(query);
  const out: T[] = [];
  try {
    let res = await iterator.next();
    while (!res.done) {
      out.push(JSON.parse(res.value.value.toString()) as T);
      res = await iterator.next();
    }
  } finally {
    await iterator.close();
  }
  return out;
}

export function selectorQuery(selector: unknown): string {
  return JSON.stringify({ selector });
}
