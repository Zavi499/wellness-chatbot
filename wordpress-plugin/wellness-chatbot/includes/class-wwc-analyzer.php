<?php
/**
 * Skin and hair analyzer shortcodes.
 *
 * `[wellness_skin_analyzer]` and `[wellness_hair_analyzer]`, each meant for
 * its own page. Deliberately a separate class from WWC_Widget with its own
 * script handle, its own config global and its own root class: the chat
 * widget mounts itself on every `.wwc-widget-root` it finds, so reusing that
 * class name here would drop a chat panel into the middle of the analyzer.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Analyzer {

	const HANDLE = 'wellness-chatbot-analyzer';

	public static function init() {
		add_shortcode( 'wellness_skin_analyzer', array( __CLASS__, 'skin_shortcode' ) );
		add_shortcode( 'wellness_hair_analyzer', array( __CLASS__, 'hair_shortcode' ) );
	}

	public static function skin_shortcode() {
		return self::render( 'skin' );
	}

	public static function hair_shortcode() {
		return self::render( 'hair' );
	}

	/**
	 * @param string $kind 'skin' or 'hair'.
	 * @return string
	 */
	private static function render( $kind ) {
		if ( ! WWC_Settings::is_connected() ) {
			// Nothing to talk to — render nothing rather than an empty box the
			// visitor can click at, matching WWC_Widget::enqueue().
			return '';
		}

		self::enqueue();

		return sprintf(
			'<div class="wwc-analyzer-mount" data-kind="%s"></div>',
			esc_attr( 'hair' === $kind ? 'hair' : 'skin' )
		);
	}

	private static function enqueue() {
		if ( wp_script_is( self::HANDLE, 'enqueued' ) ) {
			return;
		}

		// The card, button and chip styles live in the chat widget's sheet and
		// are reused verbatim; analyzer.css only adds the full-page layout.
		wp_enqueue_style(
			'wellness-chatbot-widget',
			WWC_URL . 'assets/css/widget.css',
			array(),
			wwc_asset_version( 'assets/css/widget.css' )
		);
		wp_enqueue_style(
			self::HANDLE,
			WWC_URL . 'assets/css/analyzer.css',
			array( 'wellness-chatbot-widget' ),
			wwc_asset_version( 'assets/css/analyzer.css' )
		);

		// WWC_Brand::css_vars() is normally scoped to the widget's selectors
		// only, so without this every var() in the reused card CSS resolves to
		// nothing on an analyzer page.
		wp_add_inline_style( self::HANDLE, '.wwc-analyzer-root {' . WWC_Brand::css_vars() . '}' );

		wp_enqueue_script(
			self::HANDLE,
			WWC_URL . 'assets/js/analyzer.js',
			array(),
			wwc_asset_version( 'assets/js/analyzer.js' ),
			true
		);

		wp_localize_script(
			self::HANDLE,
			'WWC_ANALYZER_CONFIG',
			array(
				'restUrl'      => esc_url_raw( rest_url( WWC_Rest::NAMESPACE ) ),
				'addToCartUrl' => class_exists( 'WC_AJAX' ) ? esc_url_raw( WC_AJAX::get_endpoint( 'add_to_cart' ) ) : '',
				'isRtl'        => is_rtl(),
				'language'     => self::language(),
				'strings'      => self::strings(),
			)
		);
	}

	/**
	 * Which language the page itself is in. Unlike the chat — where the
	 * customer's own words decide — an analyzer has no message to detect
	 * from, so the page's locale is the only signal available.
	 *
	 * @return string 'en' or 'ar'.
	 */
	private static function language() {
		return 0 === strpos( (string) get_locale(), 'ar' ) ? 'ar' : 'en';
	}

	/**
	 * Page chrome only. Question text, the AI's summary and everything on a
	 * product card come from the backend already translated.
	 *
	 * @return array<string,array<string,string>>
	 */
	private static function strings() {
		$shared_en = array(
			'compare'        => __( 'Compare', 'wellness-chatbot' ),
			'compareTitle'   => __( 'Compare options', 'wellness-chatbot' ),
			'replace'        => __( 'Replace this option', 'wellness-chatbot' ),
			'addToCart'      => __( 'Add to cart', 'wellness-chatbot' ),
			'viewProduct'    => __( 'View product', 'wellness-chatbot' ),
			'outOfStock'     => __( 'Out of stock', 'wellness-chatbot' ),
			'inStock'        => __( 'In stock', 'wellness-chatbot' ),
			'why'            => __( 'Why this?', 'wellness-chatbot' ),
			'bestFor'        => __( 'Best for', 'wellness-chatbot' ),
			'whatToKnow'     => __( 'One thing to know', 'wellness-chatbot' ),
			'howToUse'       => __( 'How to use', 'wellness-chatbot' ),
			'price'          => __( 'Price', 'wellness-chatbot' ),
			'size'           => __( 'Size', 'wellness-chatbot' ),
			'close'          => __( 'Close', 'wellness-chatbot' ),
			'helpful'        => __( 'Was this helpful?', 'wellness-chatbot' ),
			'yes'            => __( 'Yes', 'wellness-chatbot' ),
			'no'             => __( 'No', 'wellness-chatbot' ),
			'feedbackReason' => __( 'What was wrong? (optional)', 'wellness-chatbot' ),
			'send'           => __( 'Send', 'wellness-chatbot' ),
		);

		$shared_ar = array(
			'compare'        => 'مقارنة',
			'compareTitle'   => 'مقارنة الخيارات',
			'replace'        => 'استبدال هذا الخيار',
			'addToCart'      => 'أضف إلى السلة',
			'viewProduct'    => 'عرض المنتج',
			'outOfStock'     => 'غير متوفر',
			'inStock'        => 'متوفر',
			'why'            => 'لماذا هذا؟',
			'bestFor'        => 'الأفضل لـ',
			'whatToKnow'     => 'أمر يجدر معرفته',
			'howToUse'       => 'طريقة الاستخدام',
			'price'          => 'السعر',
			'size'           => 'الحجم',
			'close'          => 'إغلاق',
			'helpful'        => 'هل كان هذا مفيداً؟',
			'yes'            => 'نعم',
			'no'             => 'لا',
			'feedbackReason' => 'ما الخطأ؟ (اختياري)',
			'send'           => 'إرسال',
		);

		return array(
			'en' => array_merge(
				$shared_en,
				array(
					'skinTitle'     => __( 'AI Skin Analysis', 'wellness-chatbot' ),
					'skinIntro'     => __( 'Answer a few questions about your skin and I will suggest products from our shelves that actually suit it. You can add a photo to help me — or skip it, the questions work on their own.', 'wellness-chatbot' ),
					'hairTitle'     => __( 'AI Hair Analysis', 'wellness-chatbot' ),
					'hairIntro'     => __( 'Answer a few questions about your hair and scalp and I will suggest products from our shelves that actually suit them. You can add a photo to help me — or skip it, the questions work on their own.', 'wellness-chatbot' ),
					'photoPrompt'   => __( 'Add a photo (optional)', 'wellness-chatbot' ),
					'photoHint'     => __( 'A clear, well-lit photo in natural light works best. No filters, and nothing covering the area.', 'wellness-chatbot' ),
					'photoPrivacy'  => __( 'Your photo is used once to read this analysis and is never saved — not on this site, not on our server, and not against your account.', 'wellness-chatbot' ),
					'choosePhoto'   => __( 'Choose a photo', 'wellness-chatbot' ),
					'retakePhoto'   => __( 'Try another photo', 'wellness-chatbot' ),
					'analyzing'     => __( 'Looking at your photo…', 'wellness-chatbot' ),
					'skipPhoto'     => __( 'Skip — just ask me questions', 'wellness-chatbot' ),
					'photoUnusable' => __( "I could not read that photo clearly. Try another one, or skip it — the questions work on their own.", 'wellness-chatbot' ),
					'whatISaw'      => __( 'What I noticed', 'wellness-chatbot' ),
					'prefilledNote' => __( 'I have pre-answered a few questions based on your photo. You can change any of them as we go.', 'wellness-chatbot' ),
					'start'         => __( 'Start', 'wellness-chatbot' ),
					'back'          => __( 'Back', 'wellness-chatbot' ),
					'next'          => __( 'Continue', 'wellness-chatbot' ),
					'stepOf'        => __( '%1$d of %2$d', 'wellness-chatbot' ),
					'resultsTitle'  => __( 'What I would suggest', 'wellness-chatbot' ),
					'startOver'     => __( 'Start over', 'wellness-chatbot' ),
					'error'         => __( 'Something went wrong. Please try again.', 'wellness-chatbot' ),
					'tooLarge'      => __( 'That image is a little too large. Try another photo.', 'wellness-chatbot' ),
					'notAnImage'    => __( 'That file does not look like a photo. Try a JPEG or PNG.', 'wellness-chatbot' ),
				)
			),
			'ar' => array_merge(
				$shared_ar,
				array(
					'skinTitle'     => 'تحليل البشرة بالذكاء الاصطناعي',
					'skinIntro'     => 'أجب عن بعض الأسئلة حول بشرتك وسأقترح منتجات من متجرنا تناسبها فعلاً. يمكنك إضافة صورة لمساعدتي، أو تخطّيها — فالأسئلة تكفي وحدها.',
					'hairTitle'     => 'تحليل الشعر بالذكاء الاصطناعي',
					'hairIntro'     => 'أجب عن بعض الأسئلة حول شعرك وفروة رأسك وسأقترح منتجات من متجرنا تناسبها فعلاً. يمكنك إضافة صورة لمساعدتي، أو تخطّيها — فالأسئلة تكفي وحدها.',
					'photoPrompt'   => 'أضف صورة (اختياري)',
					'photoHint'     => 'أفضل نتيجة تكون بصورة واضحة في إضاءة طبيعية، بدون فلاتر وبدون أي شيء يغطي المنطقة.',
					'photoPrivacy'  => 'تُستخدم صورتك مرة واحدة لقراءة هذا التحليل ولا يتم حفظها أبداً — لا على هذا الموقع ولا على خوادمنا ولا في حسابك.',
					'choosePhoto'   => 'اختر صورة',
					'retakePhoto'   => 'جرّب صورة أخرى',
					'analyzing'     => 'جارٍ النظر إلى صورتك…',
					'skipPhoto'     => 'تخطّي — اسألني الأسئلة فقط',
					'photoUnusable' => 'لم أتمكن من قراءة الصورة بوضوح. جرّب صورة أخرى أو تخطَّ هذه الخطوة — فالأسئلة تكفي وحدها.',
					'whatISaw'      => 'ما لاحظته',
					'prefilledNote' => 'أجبت مسبقاً عن بعض الأسئلة بناءً على صورتك، ويمكنك تغيير أي منها أثناء التقدم.',
					'start'         => 'ابدأ',
					'back'          => 'رجوع',
					'next'          => 'متابعة',
					'stepOf'        => '%1$d من %2$d',
					'resultsTitle'  => 'ما أقترحه عليك',
					'startOver'     => 'البدء من جديد',
					'error'         => 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
					'tooLarge'      => 'حجم الصورة كبير قليلاً. جرّب صورة أخرى.',
					'notAnImage'    => 'لا يبدو هذا الملف صورة. جرّب صيغة JPEG أو PNG.',
				)
			),
		);
	}
}
