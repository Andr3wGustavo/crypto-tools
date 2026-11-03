import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

const prisma = new PrismaClient();

export interface CompoundResult {
    realizedProfitUsd: number;
    newOrderSize: number;
    currentCapital: number;
    totalProfit: number;
    growthPct: number;
    drawdownPct: number;
    halted: boolean;
}

export class CompoundService {
    private baseCapital: number;
    private currentCapital: number;
    private peakCapital: number;
    private reinvestmentRatio: number;
    private maxOrderSizeUsd: number;
    private drawdownLimit: number;
    private orderCapitalFraction: number;
    private reinvested: number = 0;
    private protectedReserve: number = 0;
    private halted: boolean = false;

    constructor(
        initialCapital = env.MM_CAPITAL_BASE,
        reinvestmentRatio = env.MM_REINVESTMENT_RATIO,
        maxOrderSizeUsd = env.MM_MAX_ORDER_USD,
        drawdownLimit = env.MM_DRAWDOWN_LIMIT,
        orderCapitalFraction = env.MM_ORDER_CAPITAL_FRACTION
    ) {
        this.baseCapital = initialCapital;
        this.currentCapital = initialCapital;
        this.peakCapital = initialCapital;
        this.reinvestmentRatio = reinvestmentRatio;
        this.maxOrderSizeUsd = maxOrderSizeUsd;
        this.drawdownLimit = drawdownLimit;
        this.orderCapitalFraction = orderCapitalFraction;
    }

    async init(): Promise<void> {
        try {
            const state = await prisma.capitalState.findUnique({ where: { id: 'singleton' } });
            if (state) {
                this.baseCapital = state.baseCapital;
                this.currentCapital = state.currentCapital;
                this.peakCapital = state.peakCapital;
                this.reinvested = state.reinvested;
                this.protectedReserve = state.protected_;
                if (this.currentCapital > this.peakCapital) this.peakCapital = this.currentCapital;
                logger.info(`[Compound] State loaded: capital=$${this.currentCapital.toFixed(2)} (base=$${this.baseCapital.toFixed(2)}, profit=$${(this.currentCapital - this.baseCapital).toFixed(2)})`);
            } else {
                await prisma.capitalState.create({
                    data: {
                        id: 'singleton',
                        baseCapital: this.baseCapital,
                        currentCapital: this.currentCapital,
                        peakCapital: this.peakCapital,
                        reinvested: 0,
                        protected_: 0
                    }
                });
                logger.info(`[Compound] State initialized: base capital $${this.baseCapital.toFixed(2)}`);
            }
        } catch (err: any) {
            logger.warn(`[Compound] Init failed (continuing in-memory): ${err.message}`);
        }
    }

    async recordProfit(realizedProfitUsd: number, currentOrderSize: number): Promise<CompoundResult> {
        this.currentCapital += realizedProfitUsd;

        if (this.currentCapital > this.peakCapital) {
            this.peakCapital = this.currentCapital;
        }

        const drawdownPct = this.peakCapital > 0
            ? (this.peakCapital - this.currentCapital) / this.peakCapital
            : 0;

        if (drawdownPct > this.drawdownLimit) {
            if (!this.halted) {
                this.halted = true;
                logger.error(`[Compound] HALTED: drawdown ${(drawdownPct * 100).toFixed(2)}% exceeds limit ${(this.drawdownLimit * 100).toFixed(2)}%.`);
            }
        }

        const totalProfit = this.currentCapital - this.baseCapital;
        let newOrderSize = currentOrderSize;

        if (!this.halted && totalProfit > 0 && realizedProfitUsd > 0) {
            const reinvestedPortion = realizedProfitUsd * this.reinvestmentRatio;
            const protectedPortion = realizedProfitUsd * (1 - this.reinvestmentRatio);

            this.reinvested += reinvestedPortion;
            this.protectedReserve += protectedPortion;

            const addedOrderAllocation = this.reinvested * 0.1;
            newOrderSize = currentOrderSize + addedOrderAllocation;
            newOrderSize = Math.min(newOrderSize, this.maxOrderSizeUsd);
            newOrderSize = Math.max(newOrderSize, env.MM_MIN_ORDER_USD);

            logger.info(`[Compound] PnL +$${realizedProfitUsd.toFixed(4)} | reinvested=$${reinvestedPortion.toFixed(4)} | protected=$${protectedPortion.toFixed(4)} | capital=$${this.currentCapital.toFixed(2)} | newOrderSize=$${newOrderSize.toFixed(2)}`);
        } else if (realizedProfitUsd <= 0) {
            logger.info(`[Compound] PnL $${realizedProfitUsd.toFixed(4)} | capital=$${this.currentCapital.toFixed(2)} | orderSize unchanged=$${currentOrderSize.toFixed(2)}`);
        }

        await this.persist();

        const growthPct = this.baseCapital > 0
            ? ((this.currentCapital - this.baseCapital) / this.baseCapital) * 100
            : 0;

        return {
            realizedProfitUsd,
            newOrderSize,
            currentCapital: this.currentCapital,
            totalProfit,
            growthPct,
            drawdownPct: drawdownPct * 100,
            halted: this.halted
        };
    }

    getSuggestedOrderSize(): number {
        if (this.halted) return env.MM_MIN_ORDER_USD;
        const suggested = this.currentCapital * this.orderCapitalFraction;
        return Math.min(Math.max(suggested, env.MM_MIN_ORDER_USD), this.maxOrderSizeUsd);
    }

    getStats() {
        const totalProfit = this.currentCapital - this.baseCapital;
        const growthPct = this.baseCapital > 0 ? (totalProfit / this.baseCapital) * 100 : 0;
        const drawdownPct = this.peakCapital > 0
            ? ((this.peakCapital - this.currentCapital) / this.peakCapital) * 100
            : 0;
        return {
            baseCapital: this.baseCapital,
            currentCapital: this.currentCapital,
            peakCapital: this.peakCapital,
            totalProfitUsd: totalProfit,
            growthPct,
            reinvested: this.reinvested,
            protectedReserve: this.protectedReserve,
            drawdownPct,
            halted: this.halted,
            reinvestmentRatio: this.reinvestmentRatio,
            maxOrderSizeUsd: this.maxOrderSizeUsd
        };
    }

    isHalted(): boolean {
        return this.halted;
    }

    async resetHalt(): Promise<void> {
        this.halted = false;
        this.peakCapital = this.currentCapital;
        await this.persist();
        logger.info('[Compound] Halt reset. Peak capital reset to current.');
    }

    private async persist(): Promise<void> {
        try {
            await prisma.capitalState.upsert({
                where: { id: 'singleton' },
                update: {
                    baseCapital: this.baseCapital,
                    currentCapital: this.currentCapital,
                    peakCapital: this.peakCapital,
                    reinvested: this.reinvested,
                    protected_: this.protectedReserve
                },
                create: {
                    id: 'singleton',
                    baseCapital: this.baseCapital,
                    currentCapital: this.currentCapital,
                    peakCapital: this.peakCapital,
                    reinvested: this.reinvested,
                    protected_: this.protectedReserve
                }
            });
        } catch (err: any) {
            logger.warn(`[Compound] Persist failed: ${err.message}`);
        }
    }
}