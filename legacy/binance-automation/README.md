# Micro MM Bot

Bot de Market Making Adaptativo para capturar spread e micro-volatilidade (respiro).

## Estrutura
- **core/**: Lógica matemática (Spread, Respiro).
- **adapters/**: Conexão com Binance (API Assinada).
- **config/**: Ajuste de risco, fees e par.
- **index.js**: Loop principal.

## Como Rodar

1. Instale dependências:
   ```bash
   npm install
   ```

2. Configure o ambiente:
   - Copie `.env.example` para `.env`
   - Adicione sua API Key e Secret da Binance (Permissões de Spot, SEM saque).
   - Adicione Webhook do Discord para logs.

3. Inicie:
   ```bash
   npm start
   ```

## Parâmetros
Ajuste `config/risk.js` para controlar o tamanho da ordem e agressividade.
