<?php
/**
 * The pharmacist-reviewer capability (spec §3.3, §3.4, §11).
 *
 * A distinct capability, assignable only by a site administrator, so the gate
 * on medical-adjacent product data cannot be bypassed by a content editor.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Roles {

	/** Capability required to mark a flagged product `verified`. */
	const CAP_PHARMACIST = 'wwc_pharmacist_review';

	/** Capability required to see the chatbot admin screens at all. */
	const CAP_MANAGE = 'wwc_manage_chatbot';

	const ROLE_PHARMACIST = 'wwc_pharmacist';

	public static function init() {
		add_filter( 'user_has_cap', array( __CLASS__, 'guard_pharmacist_cap' ), 10, 4 );
		add_action( 'admin_init', array( __CLASS__, 'maybe_upgrade_capabilities' ) );
	}

	/**
	 * Creates the reviewer role and grants management to administrators.
	 * Called on activation and whenever the plugin version changes.
	 */
	public static function add_capabilities() {
		add_role(
			self::ROLE_PHARMACIST,
			__( 'Pharmacist Reviewer', 'wellness-chatbot' ),
			array(
				'read'                => true,
				self::CAP_MANAGE      => true,
				self::CAP_PHARMACIST  => true,
				'edit_products'       => true,
				'read_private_products' => true,
			)
		);

		$admin = get_role( 'administrator' );
		if ( $admin ) {
			$admin->add_cap( self::CAP_MANAGE );
			// Note: administrators deliberately do NOT get CAP_PHARMACIST by
			// default. A site owner can grant it to themselves, but it has to be
			// a decision rather than an accident of being an admin.
		}

		$shop_manager = get_role( 'shop_manager' );
		if ( $shop_manager ) {
			$shop_manager->add_cap( self::CAP_MANAGE );
		}

		update_option( 'wwc_caps_version', WWC_VERSION );
	}

	public static function maybe_upgrade_capabilities() {
		if ( get_option( 'wwc_caps_version' ) !== WWC_VERSION ) {
			self::add_capabilities();
		}
	}

	/**
	 * Belt and braces: even if something grants the capability dynamically, only
	 * a user who genuinely holds it (or a super admin who was explicitly given
	 * it) passes. `manage_options` alone is never enough.
	 *
	 * @param array   $allcaps All capabilities of the user.
	 * @param array   $caps    Required primitive capabilities.
	 * @param array   $args    Context.
	 * @param WP_User $user    The user.
	 * @return array
	 */
	public static function guard_pharmacist_cap( $allcaps, $caps, $args, $user ) {
		unset( $caps, $args, $user );
		if ( isset( $allcaps[ self::CAP_PHARMACIST ] ) && $allcaps[ self::CAP_PHARMACIST ] ) {
			// Explicitly granted — leave it alone.
			return $allcaps;
		}
		// Make sure a stray `do_not_allow`/truthy mapping cannot appear.
		$allcaps[ self::CAP_PHARMACIST ] = false;
		return $allcaps;
	}

	public static function current_user_is_pharmacist() {
		return current_user_can( self::CAP_PHARMACIST );
	}

	public static function can_manage() {
		return current_user_can( self::CAP_MANAGE ) || current_user_can( 'manage_options' );
	}

	/**
	 * Users who currently hold the reviewer capability — shown on the settings
	 * screen so the store owner can answer open item §16.5.
	 *
	 * @return WP_User[]
	 */
	public static function pharmacists() {
		$users = get_users( array( 'role' => self::ROLE_PHARMACIST ) );
		foreach ( get_users() as $user ) {
			if ( user_can( $user, self::CAP_PHARMACIST ) && ! in_array( $user, $users, true ) ) {
				$users[] = $user;
			}
		}
		return $users;
	}
}
