-- One database per trading mode, so simulated and real ledgers can never mix.
CREATE DATABASE farm_live OWNER cortex;
\connect farm_shadow
CREATE EXTENSION IF NOT EXISTS timescaledb;
\connect farm_live
CREATE EXTENSION IF NOT EXISTS timescaledb;
