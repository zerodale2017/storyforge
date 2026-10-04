import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const source = '\uFEFF雨夜原稿\r\nep01-s00\r\n01—00内·旧车站·夜\r\n动作\r\n雨打在玻璃上。\r\n林岚〔轻声〕：\r\n我还是来了。\r\n声音\r\n远处汽笛。\r\n制作锁｜仅用于拍摄指导。\r\n'

test('existing screenplay TXT import preserves source, restores author drafts, locks and exports losslessly', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('storyforge_guide_completed', 'e2e'))
  await page.goto('./script/library')
  await page.getByRole('button', { name: '新建剧本改编', exact: true }).click()
  await page.getByLabel('剧本名称', { exact: true }).fill('已有剧本验收')
  await page.getByLabel('来源方式', { exact: true }).selectOption('existing')
  await page.getByLabel('上传已有剧本 TXT').setInputFiles({ name: '雨夜原稿.txt', mimeType: 'text/plain', buffer: Buffer.from(source) })
  await expect(page.getByRole('button', { name: '导入已有剧本', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '导入已有剧本', exact: true }).click()
  await expect(page).toHaveURL(/script\/editor\?work=\d+/)
  const action = page.getByLabel('ep01-s00-b001 内容', { exact: true })
  await expect(action).toHaveValue('雨打在玻璃上。')
  await expect(page.getByText('制作注 · 制作说明', { exact: true })).toBeVisible()
  await action.fill('雨停了。')
  // Registered author drafts survive navigating to another page and reloading.
  const nav = page.getByRole('navigation', { name: '剧本页面导航', exact: true })
  await nav.getByRole('button', { name: '原作与来源', exact: true }).click()
  await expect(page).toHaveURL(/script\/source\?work=\d+/)
  await page.reload()
  await nav.getByRole('button', { name: '剧本编辑', exact: true }).click()
  await expect(action).toHaveValue('雨停了。')
  await page.getByRole('button', { name: '保存场景', exact: true }).click()
  await expect(page.getByText(/修订 2 · 已保存/)).toBeVisible()
  await page.getByRole('button', { name: '锁定场景', exact: true }).click()
  await expect(action).toBeDisabled()
  await page.getByRole('button', { name: '解锁场景', exact: true }).click()
  await expect(action).toBeEnabled()
  await nav.getByRole('button', { name: '版本与导出', exact: true }).click()
  for (const [button, expected] of [['导出原始稿 TXT', source], ['导出修订稿 TXT', source.replace('雨打在玻璃上。', '雨停了。')]]) {
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: button, exact: true }).click()
    const download = await pending
    expect(await readFile((await download.path())!, 'utf8')).toBe(expected)
  }
  await expect(page.getByRole('alert')).toHaveCount(0)
  await nav.getByRole('button', { name: '剧本编辑', exact: true }).click()
  await page.screenshot({ path: '/private/tmp/storyforge-existing-script-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(action).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: '/private/tmp/storyforge-existing-script-mobile.png', fullPage: true })
})
