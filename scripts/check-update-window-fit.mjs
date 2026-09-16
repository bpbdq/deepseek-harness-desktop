// 验证更新窗口的高度不超过屏幕可用区域，从而底部按钮始终可见。
//
//   node scripts/check-update-window-fit.mjs
//
// 为什么单独检查：此前窗口高度固定 470，而两条轨道各含一个详情表、外加进度条与底部
// 按钮，结果**底部的"下载"按钮被截在可视区之外**——用户看不到按钮，自然无从点击。
// 这类问题的表现是"功能像是不存在"，而不是报错，所以值得用数值断言挡住。
//
// 这里复算主进程里的取高逻辑，并对几种常见屏幕尺寸给出结论。
const PANEL_WIDTH = 560
const PANEL_HEIGHT = 720
const MIN_HEIGHT = 400

/** 复算 openPanel 的取高逻辑。 */
function compute(workWidth, workHeight) {
  return {
    width: Math.min(PANEL_WIDTH, workWidth - 40),
    height: Math.max(Math.min(PANEL_HEIGHT, Math.round(workHeight * 0.9)), MIN_HEIGHT),
  }
}

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `: ${detail}`}`)
}

// 常见与极端屏幕尺寸（宽度 x 高度，单位是逻辑像素）。
const screens = [
  ['1080p', 1920, 1040],
  ['1440p', 2560, 1400],
  ['笔记本 1366x768', 1366, 728],
  ['小屏 1024x600', 1024, 560],
  ['竖屏 1080x1920', 1080, 1880],
  ['超小 800x480', 800, 440],
]

console.log('窗口取高结果（宽 x 高）')
for (const [name, width, height] of screens) {
  const size = compute(width, height)
  const fitsWidth = size.width <= width
  const fitsHeight = size.height <= height
  console.log(`  ${name.padEnd(18)} 可用 ${width}x${height}  ->  窗口 ${size.width}x${size.height}`)
  check(`  ${name} 宽度不超出`, fitsWidth)
  check(`  ${name} 高度不超出`, fitsHeight)
  // 内容大致需要的高度：两条轨道（各约 200）+ 进度条 + 底部按钮 ≈ 620。
  // 达不到这个高度时窗口仍可用（内容可滚动），但至少要保证底部按钮在视口内，
  // 这由"窗口高度 <= 屏幕高度"配合页面的固定 footer 保证。
  if (size.height < 620) {
    console.log(`       注意：高度 ${size.height} 小于内容的理想高度 620，内容会滚动；底部按钮由固定 footer 保证可见`)
  }
}

console.log('')
console.log('关键断言：窗口高度必须 <= 屏幕可用高度（否则底部按钮会被截到屏幕之外）')
const worst = screens.reduce((min, [, , h]) => Math.min(min, h), Number.POSITIVE_INFINITY)
const picked = compute(1024, worst)
check('最矮屏幕下高度仍不超出', picked.height <= worst, `${picked.height} <= ${worst}`)
check('最矮屏幕下仍高于最小高度', picked.height >= MIN_HEIGHT, String(picked.height))

console.log('')
console.log(failures === 0 ? '窗口适配检查通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
