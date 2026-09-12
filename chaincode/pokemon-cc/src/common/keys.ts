export type DocType = 'player' | 'pokemon' | 'item' | 'trade' | 'battle' | 'rand' | 'idemp';

/** 键空间约定：<DOCTYPE>:<id>（docs/chaincode-api.md §0.7）。 */
export function keyOf(docType: DocType | string, id: string): string {
  return `${docType}:${id}`;
}
