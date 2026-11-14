import { colors, spacing } from '@/theme/tokens';
import createStyles from '@/utils/createStyles';

/** win/linux 系统三键(titleBarOverlay)在右上角占位的宽度，表头右侧据此让位；单一来源 */
export const WINDOW_CONTROLS_RESERVE = 140;

const useStyles = createStyles(({ css }) =>
    css({
        '&.zhuixun-page-header': {
            display: 'flex',
            alignItems: 'center',
            flexShrink: 0,
            paddingLeft: spacing.lg,
            paddingRight: spacing.lg,
            borderBottom: `1px solid ${colors.hairline}`,
            background: colors.canvas,
            // 自定义顶栏：整条表头兼作窗口拖拽区；内部交互控件(按钮/输入/下拉/分段器)标 no-drag 保持可点
            WebkitAppRegion: 'drag',
            '& button, & input, & [class*="-select"], & [class*="-segmented"]': {
                WebkitAppRegion: 'no-drag'
            },
            // win/linux：系统三键经 titleBarOverlay 叠在右上角(约 138px 宽)，表头右侧让位，避免压住靠右控件；
            // 覆盖式声明 paddingRight 优先于基础 paddingLeft/Right（更高特异度），且不受 inline paddingBlock 影响。
            '&.platform-win': {
                paddingRight: WINDOW_CONTROLS_RESERVE
            }
        }
    })
);

export default useStyles;
