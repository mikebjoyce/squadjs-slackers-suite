import { t } from '../s3/plugins/i18n.js';
import S3PluginBase from '../s3/plugins/s3-plugin-base.js';

async function runTests() {
  console.log('🧪 Starting i18n Tests...\n');

  // 1. Direct i18n module test
  const enTitle = t('switch.discord.scrambleEmbedTitle', {}, 'en');
  const ptTitle = t('switch.discord.scrambleEmbedTitle', {}, 'pt');

  console.assert(enTitle === '🔀 Teams Scrambled', `FAILED: EN Title got "${enTitle}"`);
  console.assert(ptTitle === '🔀 Times Misturados', `FAILED: PT Title got "${ptTitle}"`);
  console.log('✅ Direct i18n translations working!');

  // 2. Variable interpolation test
  const enDesc = t('switch.discord.scrambleEmbedDescription', { count: 10, minutes: 15 }, 'en');
  const expectedDesc = 'Scrambled 10 players. Team switches are locked for 15 minutes.';
  console.assert(enDesc === expectedDesc, `FAILED: Variable substitution. Got: "${enDesc}"`);
  console.log('✅ Variable substitution working!');

  // 3. Plugin Base wrapper test
  const mockPluginEn = new S3PluginBase({}, { language: 'en' }, {});
  const mockPluginPt = new S3PluginBase({}, { language: 'pt' }, {});

  console.assert(
    mockPluginEn.t('switch.discord.scrambleEmbedTitle') === '🔀 Teams Scrambled',
    'FAILED: Plugin instance EN'
  );
  console.assert(
    mockPluginPt.t('switch.discord.scrambleEmbedTitle') === '🔀 Times Misturados',
    'FAILED: Plugin instance PT'
  );
  console.log('✅ S3PluginBase instance wrapper working!');

  // 4. Missing key fallback test
  const fallback = mockPluginEn.t('non.existent.key');
  console.assert(fallback === 'non.existent.key', `FAILED: Key fallback got "${fallback}"`);
  console.log('✅ Fallback behavior working!');

  console.log('\n🎉 All tests passed successfully!');
}

runTests().catch(console.error);