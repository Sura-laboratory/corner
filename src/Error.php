<?php

declare(strict_types=1);

namespace Sura\Corner;

/**
 * Class Error.
 */
class Error extends \Error implements CornerInterface
{
    use CornerTrait;
}
