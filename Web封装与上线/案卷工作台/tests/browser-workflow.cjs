// playwright-cli run-code --filename tests/browser-workflow.cjs
async (page) => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const dialog = page.locator('#workspace-dialog');
  const folio = page.locator('#folio');
  const rail = page.locator('#material-list');
  const annotation = page.locator('#annotations');
  const title = '乔乙与虚构单位';
  const wage = '虚构员工乔乙2025年11月工资约定6100元。';
  const receipt = '虚构单位于2025年12月2日向乔乙实际支付2025年11月工资4900元，回单号TEST-001。';
  const action = (name) => page.locator('[data-action="' + name + '"]').first();
  const field = (name) => dialog.locator('[name="' + name + '"]');
  const submit = () => dialog.locator('button[type=submit]').click();
  const notice = (message) => page.locator('#notice').getByText(message, { exact: false }).waitFor();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(response.status() + ' ' + new URL(response.url()).pathname);
  });
  await page.setViewportSize({ width: 1440, height: 980 });

  const create = async (name, number = '') => {
    await action('new-case').click();
    await field('title').fill(name);
    if (number) await field('caseNumber').fill(number);
    await submit();
    await notice('已创建案件');
    await page.locator('#case-title').getByText(name).waitFor();
  };
  const addText = async (label, text) => {
    await action('add-material').click();
    await field('uploadMode').selectOption('text');
    await field('sourceLabel').fill(label);
    await field('text').fill(text);
    await submit();
    await notice('材料原件已保存');
    await folio.getByRole('heading', { name: label, exact: true }).waitFor();
  };
  const run = async (goal) => {
    await annotation.locator('[data-action="run-intake"]').click();
    await field('goal').fill(goal);
    await field('consent').check();
    await submit();
    await notice('接案核对已保存');
    await folio.getByRole('heading', { name: '接案底稿', exact: true }).waitFor();
  };

  await create(title, '027');
  await addText('工资约定', wage);
  await action('add-material').click();
  await field('sourceLabel').fill('九月工资清册');
  await field('file').setInputFiles('../../底座/examples/fixtures/ocr-sample.png');
  await submit();
  await notice('材料原件已保存');
  await annotation.getByRole('button', { name: '运行 OCR' }).click();
  const transcription = annotation.locator('textarea[name=text]');
  await transcription.waitFor({ timeout: 120_000 });
  const initial = await transcription.inputValue();
  check(/6000/u.test(initial), 'Real OCR did not recover the amount in the sample.');
  const line = folio.locator('.ocr-hit').first();
  await line.click();
  await folio.locator('.ocr-hit[aria-pressed=true]').waitFor();
  await transcription.fill('模拟材料：九月工资6000元。');
  await page.locator('.annotation-leader:not([hidden])').waitFor();
  const floor = await page.evaluate(() => {
    const paper = document.querySelector('#folio').getBoundingClientRect().bottom;
    const navigation = document.querySelector('#workspace-tabs').getBoundingClientRect().bottom;
    return { paper, navigation, screen: innerHeight };
  });
  check(floor.paper > floor.screen - 100 && Math.abs(floor.paper - floor.navigation) < 85,
    'Desktop paper and stage navigation do not share a floor: ' + JSON.stringify(floor));
  await page.screenshot({ path: 'output/playwright/案卷工作台-核对批注.png' });
  await annotation.getByRole('button', { name: '保存修订' }).click();
  await notice('修订已保存为新版本');
  await annotation.getByRole('button', { name: '文字版本' }).click();
  await dialog.getByRole('button', { name: '查看此版本' }).first().click();
  const historicalText = annotation.locator('.historical-version .source-text');
  await historicalText.waitFor();
  check(await historicalText.textContent() === initial, 'OCR version changed during revision.');

  await run('核对虚构工资材料');
  await folio.getByText(wage, { exact: true }).first().waitFor();
  await action('case-history').click();
  await field('label').fill('补料前');
  await submit();
  await notice('案件保存点已创建');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await addText('银行付款回单', receipt);
  await run('补入虚构银行回单后核对');
  await page.locator('#workspace-tabs [data-view=nodes]').click();
  await folio.getByRole('button', { name: '对照核对轮次' }).click();
  await submit();
  await notice('已生成关键节点对照');
  await folio.getByText('银行付款回单', { exact: false }).first().waitFor();
  await annotation.getByRole('button', { name: '导出底稿' }).click();
  await submit();
  await notice('底稿已保存');
  const [downloaded] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('link', { name: '下载 Word' }).first().click(),
  ]);
  check(downloaded.suggestedFilename().endsWith('.docx'), 'Word export has the wrong filename.');
  check(await downloaded.failure() === null, 'Word export download failed.');
  await dialog.getByRole('button', { name: '查看底稿' }).first().click();
  await dialog.getByRole('heading', { name: '已保存底稿', exact: true }).waitFor();
  await dialog.getByRole('button', { name: '查看已保存节点对照' }).click();
  await folio.getByText('银行付款回单', { exact: false }).first().waitFor();

  await action('edit-case').click();
  await field('stage').fill('等待补料');
  await submit();
  await notice('案件进度已保存');
  await page.locator('#case-meta').getByText('等待补料', { exact: false }).waitFor();
  await action('case-history').click();
  await dialog.locator('.record-entry').filter({ hasText: '补料前' }).getByRole('button', { name: '预览恢复' }).click();
  await dialog.getByRole('button', { name: '确认恢复整个案件' }).click();
  await notice('整个案件已恢复到保存点');
  check(await rail.getByText('银行付款回单', { exact: false }).count() === 0, 'Rollback kept the later receipt.');
  check(!(await page.locator('#case-meta').textContent()).includes('等待补料'), 'Rollback kept the later case stage.');

  await create('独立虚构案件');
  check(await rail.getByText('工资约定', { exact: false }).count() === 0, 'Materials leaked between cases.');
  await page.locator('#case-list').getByText(title, { exact: false }).first().click();
  await page.locator('#case-title').getByText(title).waitFor();
  await page.reload();
  await page.locator('#case-title').getByText(title).waitFor();
  await rail.getByText('九月工资清册', { exact: false }).waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    const fits = await page.evaluate(() => document.body.scrollWidth <= window.innerWidth);
    check(fits, 'Horizontal body overflow at width ' + width);
  }
  check(errors.length === 0, errors.join('\n'));
  return 'PASS: browser create/isolation/reopen, upload/OCR/revision/history, intake, node review, DOCX, rollback, 390px and 320px';
}
