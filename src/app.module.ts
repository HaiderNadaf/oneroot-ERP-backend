import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AccountingModule } from './accounting/accounting.module.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BranchesModule } from './branches/branches.module.js';
import { CashModule } from './cash/cash.module.js';
import { CategoriesModule } from './categories/categories.module.js';
import { GovtModule } from './compliance/govt.module.js';
import { AuthGuard } from './common/auth.guard.js';
import { InvalidateOnWrite } from './common/invalidate.interceptor.js';
import { CustomersModule } from './customers/customers.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { ExpensesModule } from './expenses/expenses.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { ProcurementModule } from './procurement/procurement.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProductsModule } from './products/products.module.js';
import { PurchasesModule } from './purchases/purchases.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { SalesModule } from './sales/sales.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { UsersModule } from './users/users.module.js';
import { VendorsModule } from './vendors/vendors.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN ?? '7d') as `${number}d` },
    }),
    PrismaModule,
    AuditModule,
    AccountingModule,
    NotificationsModule,
    ApprovalsModule,
    PricingModule,
    CashModule,
    GovtModule,
    InventoryModule,
    PaymentsModule,
    AuthModule,
    BranchesModule,
    UsersModule,
    SettingsModule,
    CategoriesModule,
    ProductsModule,
    VendorsModule,
    CustomersModule,
    PurchasesModule,
    ProcurementModule,
    SalesModule,
    ExpensesModule,
    DashboardModule,
    ReportsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: InvalidateOnWrite },
  ],
})
export class AppModule {}
