<?php
/**
 * Storefront widget embedding (spec §9.1).
 *
 * Shortcode `[wellness_chatbot]` for manual placement, plus an opt-in setting
 * that injects a floating launcher site-wide. The bundle is small and only
 * enqueued where it is actually used.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Widget {

	/** @var bool Whether the shortcode ran on this request. */
	private static $shortcode_used = false;

	public static function init() {
		add_shortcode( 'wellness_chatbot', array( __CLASS__, 'shortcode' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'maybe_enqueue' ) );
		add_action( 'wp_footer', array( __CLASS__, 'maybe_render_launcher' ) );
	}

	/**
	 * @param array $atts Shortcode attributes.
	 * @return string
	 */
	public static function shortcode( $atts ) {
		$atts = shortcode_atts(
			array(
				'mode' => 'inline', // inline | launcher
			),
			$atts,
			'wellness_chatbot'
		);

		self::$shortcode_used = true;
		self::enqueue();

		return sprintf(
			'<div class="wwc-widget-root" data-mode="%s"></div>',
			esc_attr( 'launcher' === $atts['mode'] ? 'launcher' : 'inline' )
		);
	}

	public static function maybe_enqueue() {
		if ( WWC_Settings::auto_inject() ) {
			self::enqueue();
		}
	}

	public static function maybe_render_launcher() {
		if ( ! WWC_Settings::auto_inject() || self::$shortcode_used ) {
			return;
		}
		echo '<div class="wwc-widget-root" data-mode="launcher"></div>';
	}

	public static function enqueue() {
		if ( wp_script_is( 'wellness-chatbot-widget', 'enqueued' ) ) {
			return;
		}
		if ( ! WWC_Settings::is_connected() ) {
			return; // nothing to talk to; do not ship a dead widget
		}

		wp_enqueue_style(
			'wellness-chatbot-widget',
			WWC_URL . 'assets/css/widget.css',
			array(),
			WWC_VERSION
		);

		// The brand ramp is injected as CSS variables so the widget inherits the
		// store's palette without a second stylesheet to keep in sync.
		wp_add_inline_style(
			'wellness-chatbot-widget',
			'.wwc-widget-root, .wwc-panel, .wwc-launcher {' . WWC_Brand::css_vars() . '}'
		);

		wp_enqueue_script(
			'wellness-chatbot-widget',
			WWC_URL . 'assets/js/widget.js',
			array(),
			WWC_VERSION,
			true
		);

		wp_localize_script(
			'wellness-chatbot-widget',
			'WWC_CONFIG',
			array(
				'restUrl'      => esc_url_raw( rest_url( WWC_Rest::NAMESPACE ) ),
				'addToCartUrl' => esc_url_raw( wc_get_cart_url() ),
				'ajaxUrl'      => esc_url_raw( admin_url( 'admin-ajax.php' ) ),
				'isRtl'        => is_rtl(),
				'locale'       => get_locale(),
				'strings'      => self::strings(),
			)
		);
	}

	/**
	 * Widget chrome, bilingual. Conversation text comes from the backend; these
	 * are only the labels around it.
	 *
	 * @return array<string,array<string,string>>
	 */
	private static function strings() {
		return array(
			'en' => array(
				'launcher'        => __( 'Need help choosing?', 'wellness-chatbot' ),
				'title'           => __( 'Wellness World Assistant', 'wellness-chatbot' ),
				'placeholder'     => __( 'Type your message…', 'wellness-chatbot' ),
				'send'            => __( 'Send', 'wellness-chatbot' ),
				'close'           => __( 'Close chat', 'wellness-chatbot' ),
				'open'            => __( 'Open chat', 'wellness-chatbot' ),
				'thinking'        => __( 'Thinking…', 'wellness-chatbot' ),
				'why'             => __( 'Why this?', 'wellness-chatbot' ),
				'compare'         => __( 'Compare', 'wellness-chatbot' ),
				'replace'         => __( 'Replace this option', 'wellness-chatbot' ),
				'addToCart'       => __( 'Add to cart', 'wellness-chatbot' ),
				'viewProduct'     => __( 'View product', 'wellness-chatbot' ),
				'outOfStock'      => __( 'Out of stock', 'wellness-chatbot' ),
				'inStock'         => __( 'In stock', 'wellness-chatbot' ),
				'helpful'         => __( 'Was this helpful?', 'wellness-chatbot' ),
				'yes'             => __( 'Yes', 'wellness-chatbot' ),
				'no'              => __( 'No', 'wellness-chatbot' ),
				'feedbackReason'  => __( 'What was wrong? (optional)', 'wellness-chatbot' ),
				'back'            => __( 'Back', 'wellness-chatbot' ),
				'stepOf'          => __( '%1$d of %2$d', 'wellness-chatbot' ),
				'error'           => __( 'Something went wrong. Please try again.', 'wellness-chatbot' ),
				'privacy'         => __( 'Privacy', 'wellness-chatbot' ),
				'compareTitle'    => __( 'Compare options', 'wellness-chatbot' ),
				'bestFor'         => __( 'Best for', 'wellness-chatbot' ),
				'whatToKnow'      => __( 'One thing to know', 'wellness-chatbot' ),
				'howToUse'        => __( 'How to use', 'wellness-chatbot' ),
				'price'           => __( 'Price', 'wellness-chatbot' ),
				'size'            => __( 'Size', 'wellness-chatbot' ),
			),
			'ar' => array(
				'launcher'        => 'تحتاج مساعدة في الاختيار؟',
				'title'           => 'مساعد Wellness World',
				'placeholder'     => 'اكتب رسالتك…',
				'send'            => 'إرسال',
				'close'           => 'إغلاق المحادثة',
				'open'            => 'فتح المحادثة',
				'thinking'        => 'جارٍ التفكير…',
				'why'             => 'لماذا هذا؟',
				'compare'         => 'مقارنة',
				'replace'         => 'استبدال هذا الخيار',
				'addToCart'       => 'أضف إلى السلة',
				'viewProduct'     => 'عرض المنتج',
				'outOfStock'      => 'غير متوفر',
				'inStock'         => 'متوفر',
				'helpful'         => 'هل كان هذا مفيداً؟',
				'yes'             => 'نعم',
				'no'              => 'لا',
				'feedbackReason'  => 'ما الخطأ؟ (اختياري)',
				'back'            => 'رجوع',
				'stepOf'          => '%1$d من %2$d',
				'error'           => 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
				'privacy'         => 'الخصوصية',
				'compareTitle'    => 'مقارنة الخيارات',
				'bestFor'         => 'الأفضل لـ',
				'whatToKnow'      => 'أمر يجدر معرفته',
				'howToUse'        => 'طريقة الاستخدام',
				'price'           => 'السعر',
				'size'            => 'الحجم',
			),
		);
	}
}
