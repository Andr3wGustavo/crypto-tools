const axios = require('axios')
require('dotenv').config()

async function logDiscord(msg) {
    if (!process.env.DISCORD_WEBHOOK) {
        // console.log('No Discord Logger configured')
        return
    }
    try {
        // If msg is object, format it
        let content = msg
        if (typeof msg === 'object') {
            content = "```json\n" + JSON.stringify(msg, null, 2) + "\n```"
        }

        await axios.post(process.env.DISCORD_WEBHOOK, {
            content: content
        })
    } catch (err) {
        console.error('Discord Log Error:', err.message)
    }
}

module.exports = { logDiscord }
