let mids = []

function updateMid(bid, ask, window = 50) {
  // Ensure valid numbers
  bid = parseFloat(bid)
  ask = parseFloat(ask)
  const mid = (bid + ask) / 2
  mids.push(mid)
  if (mids.length > window) mids.shift()
  return mid
}

function calcRespiro() {
  if (mids.length < 2) return 0
  let sum = 0
  for (let i = 1; i < mids.length; i++) {
    sum += Math.abs(mids[i] - mids[i - 1]) / mids[i - 1]
  }
  return sum / (mids.length - 1)
}

module.exports = { updateMid, calcRespiro }
