<?php
/**
 * Admin menu and shared rendering helpers (spec §8).
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Admin {

	const MENU_SLUG = 'wellness-chatbot';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'register_menu' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ) );

		WWC_Admin_Labels::init();
		WWC_Admin_Kb::init();
		WWC_Admin_Escalations::init();
		WWC_Admin_Analytics::init();
		WWC_Admin_Settings::init();
		WWC_Admin_History::init();
	}

	public static function register_menu() {
		$cap = WWC_Roles::CAP_MANAGE;

		add_menu_page(
			__( 'Wellness Chatbot', 'wellness-chatbot' ),
			__( 'Wellness Chatbot', 'wellness-chatbot' ),
			$cap,
			self::MENU_SLUG,
			array( 'WWC_Admin_Labels', 'render' ),
			'dashicons-format-chat',
			56
		);

		$pages = array(
			array( self::MENU_SLUG, __( 'Label Review Queue', 'wellness-chatbot' ), array( 'WWC_Admin_Labels', 'render' ) ),
			array( self::MENU_SLUG . '-kb', __( 'Knowledge Base', 'wellness-chatbot' ), array( 'WWC_Admin_Kb', 'render' ) ),
			array( self::MENU_SLUG . '-escalations', __( 'Escalation Log', 'wellness-chatbot' ), array( 'WWC_Admin_Escalations', 'render' ) ),
			array( self::MENU_SLUG . '-analytics', __( 'Analytics', 'wellness-chatbot' ), array( 'WWC_Admin_Analytics', 'render' ) ),
			array( self::MENU_SLUG . '-settings', __( 'Settings', 'wellness-chatbot' ), array( 'WWC_Admin_Settings', 'render' ) ),
			array( self::MENU_SLUG . '-history', __( 'Version History', 'wellness-chatbot' ), array( 'WWC_Admin_History', 'render' ) ),
		);

		foreach ( $pages as $page ) {
			add_submenu_page( self::MENU_SLUG, $page[1], $page[1], $cap, $page[0], $page[2] );
		}
	}

	/**
	 * @param string $hook Current admin page hook.
	 */
	public static function enqueue( $hook ) {
		if ( false === strpos( $hook, self::MENU_SLUG ) ) {
			return;
		}

		wp_enqueue_style( 'wellness-chatbot-admin', WWC_URL . 'assets/css/admin.css', array(), WWC_VERSION );
		wp_add_inline_style( 'wellness-chatbot-admin', '.wwc-admin {' . WWC_Brand::css_vars() . '}' );

		wp_enqueue_script( 'wellness-chatbot-admin', WWC_URL . 'assets/js/admin.js', array(), WWC_VERSION, true );
		wp_localize_script(
			'wellness-chatbot-admin',
			'WWC_ADMIN',
			array(
				'ajaxUrl' => admin_url( 'admin-ajax.php' ),
				'nonce'   => wp_create_nonce( 'wwc_admin' ),
				'strings' => array(
					'confirmReject' => __( 'Reject this AI draft? The product stays unverified.', 'wellness-chatbot' ),
					'saving'        => __( 'Saving…', 'wellness-chatbot' ),
					'saved'         => __( 'Saved', 'wellness-chatbot' ),
					'failed'        => __( 'Failed', 'wellness-chatbot' ),
				),
			)
		);
	}

	/**
	 * Standard page shell so every screen looks the same.
	 *
	 * @param string   $title    Page title.
	 * @param callable $callback Body renderer.
	 */
	public static function page( $title, $callback ) {
		if ( ! WWC_Roles::can_manage() ) {
			wp_die( esc_html__( 'You do not have permission to view this page.', 'wellness-chatbot' ) );
		}

		echo '<div class="wrap wwc-admin">';
		echo '<h1>' . esc_html( $title ) . '</h1>';
		self::connection_notice();
		call_user_func( $callback );
		echo '</div>';
	}

	private static function connection_notice() {
		if ( WWC_Settings::is_connected() ) {
			return;
		}
		printf(
			'<div class="notice notice-error"><p>%s <a href="%s">%s</a></p></div>',
			esc_html__( 'The chatbot backend is not connected, so these screens have no data.', 'wellness-chatbot' ),
			esc_url( admin_url( 'admin.php?page=' . self::MENU_SLUG . '-settings' ) ),
			esc_html__( 'Configure it', 'wellness-chatbot' )
		);
	}

	/**
	 * Renders a WP_Error as an admin notice.
	 *
	 * @param WP_Error $error Error.
	 */
	public static function error_notice( $error ) {
		printf(
			'<div class="notice notice-error"><p>%s</p></div>',
			esc_html( $error->get_error_message() )
		);
	}

	/**
	 * Verifies the admin nonce and capability for a POST handler.
	 *
	 * @param string $action Nonce action.
	 */
	public static function verify_post( $action ) {
		if ( ! WWC_Roles::can_manage() ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'wellness-chatbot' ) );
		}
		check_admin_referer( $action );
	}

	/**
	 * @param string $page   Page slug.
	 * @param array  $notice Optional query args, e.g. array( 'wwc_notice' => 'saved' ).
	 */
	public static function redirect_back( $page, array $notice = array() ) {
		wp_safe_redirect( add_query_arg( $notice, admin_url( 'admin.php?page=' . $page ) ) );
		exit;
	}

	public static function render_notice_from_query() {
		$notice = isset( $_GET['wwc_notice'] ) ? sanitize_key( wp_unslash( $_GET['wwc_notice'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( '' === $notice ) {
			return;
		}

		$messages = array(
			'saved'               => array( 'success', __( 'Saved.', 'wellness-chatbot' ) ),
			'approved'            => array( 'success', __( 'Product approved and marked verified.', 'wellness-chatbot' ) ),
			'rejected'            => array( 'success', __( 'Draft rejected. The product stays unverified.', 'wellness-chatbot' ) ),
			'relabeled'           => array( 'success', __( 'AI labeling re-run. The new draft is at the top of the queue.', 'wellness-chatbot' ) ),
			'resolved'            => array( 'success', __( 'Escalation marked resolved.', 'wellness-chatbot' ) ),
			'reset'               => array( 'success', __( 'Unreviewed AI drafts cleared. Verified and partial products were left untouched.', 'wellness-chatbot' ) ),
			'failed'              => array( 'error', __( 'That did not work. Check the backend connection and try again.', 'wellness-chatbot' ) ),
		);

		if ( ! isset( $messages[ $notice ] ) ) {
			return;
		}

		printf(
			'<div class="notice notice-%s is-dismissible"><p>%s</p></div>',
			esc_attr( $messages[ $notice ][0] ),
			esc_html( $messages[ $notice ][1] )
		);
	}
}
