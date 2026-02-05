/**
 * Prisma client type augmentation.
 * Only declares models that exist in prisma/schema.prisma.
 * All fields are optional (?) to avoid conflicts with the real generated PrismaClient.
 * In Docker/production, prisma generate provides the real types.
 */
declare module '@prisma/client' {
  export class PrismaClient {
    user?: any;
    userApiKey?: any;
    userSetting?: any;
    agentSession?: any;
    agentActionIntent?: any;
    pendingIntent?: any;
    order?: any;
    fill?: any;
    trade?: any;
    position?: any;
    sessionKpi?: any;
    triggerLog?: any;
    dailyReport?: any;
    systemSetting?: any;
    tradeParityResult?: any;
    $executeRaw?: any;
    $transaction?: any;
  }
}
