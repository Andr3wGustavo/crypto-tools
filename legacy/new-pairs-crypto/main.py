# main.py
import discord
import os
from dotenv import load_dotenv

load_dotenv() # Carrega as variáveis do arquivo .env
DISCORD_BOT_TOKEN = os.getenv('DISCORD_BOT_TOKEN')

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)

@client.event
async def on_ready():
    print(f'Oráculo {client.user} despertou e está vigilante.')

@client.event
async def on_message(message):
    if message.author == client.user:
        return
    if message.content.startswith('!ping'):
        await message.channel.send('Pong! A conexão com o plano etéreo está estável.')

client.run(DISCORD_BOT_TOKEN)
