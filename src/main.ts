import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { ExecutionModule } from './module';
import { PrismaService } from './common/prisma.service';

const APP_TIMEZONE = process.env.TZ || 'America/Santo_Domingo';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5175')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(ExecutionModule, {
    bufferLogs: true,
  });
  const configService = app.get(ConfigService);
  const prismaService = app.get(PrismaService);

  app.useLogger(
    new ConsoleLogger({
      timestamp: true,
    }),
  );

  app.set('trust proxy', 1);

  app.use(helmet());
  app.enableCors({
    origin: CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    maxAge: 86400,
  });
  app.setGlobalPrefix(configService.get<string>('API_PREFIX', 'api'));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: false,
    }),
  );

  prismaService.enableShutdownHooks(app);

  const port = configService.get<number>('PORT', 3001);
  await app.listen(port, '0.0.0.0');

  const bootstrapLogger = new ConsoleLogger('Bootstrap', { timestamp: true });
  bootstrapLogger.log(`Kai execution API listening on port ${port} (timezone ${APP_TIMEZONE})`);
}

bootstrap().catch((error) => {
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
