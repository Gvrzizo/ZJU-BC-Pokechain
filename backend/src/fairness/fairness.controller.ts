import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ContractService } from '../fabric/contract.service';
import { CAPTURE_DERIVATION_DOC } from '../pokemon/capture-derive';
import { SigningService } from '../battles/signing.service';
import { Public } from '../common/decorators/api.decorators';

const BATTLE_DERIVATION_DOC =
  'battle randomness: rand(n)=HMAC-SHA256(key=serverSeed,msg=`${clientSeed}|${eventId}|${n}`)/2^64, ' +
  'consumed in order by the engine (hit roll, crit roll, damage factor 0.85+r*0.15, speed ties). ' +
  'resultHash=sha256(canonical(turnLog)); serverSig=secp256k1/SHA-256 over resultHash bytes (DER hex).';

@Public()
@Controller('fairness')
export class FairnessController {
  constructor(
    private readonly contract: ContractService,
    private readonly signing: SigningService,
  ) {}

  /** Full commit-reveal disclosure + derivation recipe so anyone can recompute. */
  @Get(':eventId')
  async fairness(@Param('eventId') eventId: string) {
    const random = await this.contract.getRandom(eventId).catch(() => null);
    if (!random) {
      throw new NotFoundException(`EVENT_NOT_FOUND: random event ${eventId} does not exist`);
    }
    return {
      event: random,
      derivation: {
        algorithm:
          'rand(n) = first8bytes(HMAC-SHA256(key=serverSeed, msg=`${clientSeed}|${eventId}|${n}`)) as big-endian uint64 / 2^64',
        commitVerify: 'sha256(serverSeed) === commitHash',
        resultHashVerify: 'sha256(`${serverSeed}|${clientSeed}|${eventId}`) === resultHash',
        captureLayout: CAPTURE_DERIVATION_DOC,
        battleLayout: BATTLE_DERIVATION_DOC,
      },
      serverPublicKey: this.signing.publicKeyPem,
    };
  }
}
