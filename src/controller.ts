import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ExecutionService } from './execution.service';
import { QueryService } from './query.service';

@UseGuards(JwtAuthGuard)
@Controller('trading')
export class ExecutionController {
  constructor(
    private readonly query: QueryService,
    private readonly execution: ExecutionService,
  ) {}

  @Get('accounts')
  listAccounts(@Req() req: Request & { user?: { sub?: string; id?: string } }) {
    return this.query.listAccounts(this.getUserId(req));
  }

  @Get('accounts/:id/positions')
  listPositions(
    @Req() req: Request & { user?: { sub?: string; id?: string } },
    @Param('id') id: string,
  ) {
    return this.query.listPositions(this.getUserId(req), id);
  }

  @Post('orders')
  placeOrder(
    @Req() req: Request & { user?: { sub?: string; id?: string } },
    @Body() body: unknown,
  ) {
    return this.execution.placeOrder(this.getUserId(req), body);
  }

  @Post('positions/:ticket/close')
  closePosition(
    @Req() req: Request & { user?: { sub?: string; id?: string } },
    @Param('ticket') ticket: string,
    @Body() body: unknown,
  ) {
    return this.execution.closePosition(
      this.getUserId(req),
      ticket,
      body,
    );
  }

  @Patch('positions/:ticket/stops')
  updatePositionStops(
    @Req() req: Request & { user?: { sub?: string; id?: string } },
    @Param('ticket') ticket: string,
    @Body() body: unknown,
  ) {
    return this.execution.updatePositionStops(
      this.getUserId(req),
      ticket,
      body,
    );
  }

  private getUserId(req: Request & { user?: { sub?: string; id?: string } }): string {
    const userId = req.user?.sub || req.user?.id;
    if (!userId) {
      throw new UnauthorizedException();
    }
    return userId;
  }
}
