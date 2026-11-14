import createStyles from '@/utils/createStyles';

const useStyles = createStyles(({ css, token }) => {
    return css({
        '&.basic-layout': {
            display: 'flex',
            height: '100vh',
            background: token.colorBgLayout
        }
    });
});

export default useStyles;
