import { Controller, Get } from '@nestjs/common';
import { Public } from './decorators/api.decorators';

/**
 * Liveness probe for docker-compose healthchecks / smoke scripts.
 * Public (no JWT), GET-only (replay interceptor skips it), cheap.
 */
@Public()
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', uptime: Math.round(process.uptime()), ts: new Date().toISOString() };
  }
}
